// Redline — apply-fix loop (Butterbase serverless function)
// Endpoint: POST /v1/{app_id}/fn/apply-fix
//
// Takes a Config + a recommended guard, adds the guard, reruns the scan, and
// returns before/after so the UI can show "red goes green". Not paywalled —
// you can only fix a config you were allowed to scan.
//
// Body: { config?, scanId?, guard? | recommendedFix?, fix? }
//   - Provide `config` inline, or `scanId` to load the original config from history.
//   - Provide the guard to add as `guard` ({guard|name, placement}) or a full
//     `recommendedFix`/`fix` object. If omitted, the scan's own recommendedFix is used.
//
// Pipeline helpers are duplicated from scan.ts on purpose: Butterbase functions
// are isolated single files and cannot import each other. Keep the two in sync.

const SINK_KW = ["refund", "payment", "pay ", "transfer", "send", "delete", "remove",
  "execute", "run command", "deploy", "purchase", "charge", "issue", "publish",
  "post ", "write", "modify", "wire", "provision", "grant", "email a", "reply"];
const GUARD_KW = ["approv", "verify", "confirm", "human", "review", "sanitiz",
  "moderat", "allowlist", "whitelist", "guard", "permission check", "validate input"];
const SOURCE_KW = ["read", "incoming", "customer-provided", "fetch", "url", "external",
  "scrape", "download", "receive", "inbox", "message", "comment", "ticket", "upload",
  "webhook", "user input", "untrusted", "browse"];
const CRITICAL_KW = ["refund", "payment", "pay", "transfer", "charge", "wire", "delete",
  "remove", "execute", "deploy", "purchase", "grant", "provision"];
const HIGH_KW = ["send", "email", "post", "publish", "write", "modify", "message", "reply"];

function anyKw(text: string, kws: string[]): boolean {
  const t = " " + (text || "").toLowerCase() + " ";
  return kws.some((k) => t.includes(k));
}
function classifyRole(desc: string) {
  const d = desc || "";
  if (anyKw(d, GUARD_KW)) return { role: "guard", privileged: false };
  if (anyKw(d, SINK_KW)) return { role: "sink", privileged: true };
  if (anyKw(d, SOURCE_KW)) return { role: "source", privileged: false };
  return { role: "passthrough", privileged: false };
}
function severityForSink(desc: string) {
  if (anyKw(desc || "", CRITICAL_KW)) return "critical";
  if (anyKw(desc || "", HIGH_KW)) return "high";
  return "medium";
}
const SEV_RANK: Record<string, number> = { critical: 3, high: 2, medium: 1, low: 0 };

function normalizeGuards(guards: any[]) {
  if (!Array.isArray(guards)) return [];
  return guards.map((g) => {
    if (typeof g === "string") return { name: g, placement: null };
    return { name: g.guard || g.name || g.id || "guard", placement: g.placement ?? g.at ?? g.on ?? null };
  });
}
function guardCoversPath(guard: any, path: string[]) {
  const p = guard.placement;
  if (p === null || p === "*" || p === "all") return true;
  return path.includes(p);
}

function classify(config: any) {
  const tools = Array.isArray(config.tools) ? config.tools : [];
  const nodes = tools.map((t: any) => {
    const { role, privileged } = classifyRole(t.description);
    return { id: t.name, role, privileged,
      rationale: role === "source" ? `Ingests untrusted external input: "${t.description}"`
        : role === "sink" ? `Performs a privileged action: "${t.description}"`
        : role === "guard" ? `Acts as a safety check: "${t.description}"`
        : `Internal / low-risk operation: "${t.description}"` };
  });
  const sources = nodes.filter((n: any) => n.role === "source");
  const sinks = nodes.filter((n: any) => n.role === "sink");
  const edges: any[] = [];
  for (const s of sources) for (const k of sinks) edges.push({ from: s.id, via: "context", to: k.id });
  return { nodes, edges, guards: normalizeGuards(config.guards) };
}

function runScan(graph: any, config: any) {
  const nodes = graph.nodes || [];
  const guards = normalizeGuards(graph.guards || []);
  const descById: Record<string, string> = {};
  for (const t of (config.tools || [])) descById[t.name] = t.description || "";
  const sources = nodes.filter((n: any) => n.role === "source");
  const sinks = nodes.filter((n: any) => n.role === "sink" && n.privileged);
  const vulnerablePaths: any[] = [];
  let idx = 0;
  for (const s of sources) for (const k of sinks) {
    const path = [s.id, "context", k.id];
    if (!guards.some((g) => guardCoversPath(g, path))) {
      idx += 1;
      vulnerablePaths.push({
        id: `p${idx}`, path, severity: severityForSink(descById[k.id]),
        explanation:
          `Untrusted data from "${s.id}" (${descById[s.id] || "external input"}) flows through the agent's ` +
          `shared context into "${k.id}" (${descById[k.id] || "privileged action"}) with no guard in between.`,
      });
    }
  }
  const summary = { sources: sources.length, sinks: sinks.length, guards: guards.length, vulnerablePaths: vulnerablePaths.length };
  let recommendedFix: any = null;
  if (vulnerablePaths.length > 0) {
    const bySink: Record<string, { count: number; sev: string }> = {};
    for (const vp of vulnerablePaths) {
      const sink = vp.path[vp.path.length - 1];
      if (!bySink[sink]) bySink[sink] = { count: 0, sev: vp.severity };
      bySink[sink].count += 1;
      if (SEV_RANK[vp.severity] > SEV_RANK[bySink[sink].sev]) bySink[sink].sev = vp.severity;
    }
    let best: string | null = null;
    for (const sink of Object.keys(bySink)) {
      if (best === null || bySink[sink].count > bySink[best].count ||
        (bySink[sink].count === bySink[best].count && SEV_RANK[bySink[sink].sev] > SEV_RANK[bySink[best].sev])) best = sink;
    }
    recommendedFix = {
      guard: "human_approval", placement: best,
      pathsEliminated: bySink[best!].count, pathsTotal: vulnerablePaths.length,
      rationale: `Placing a human_approval check at "${best}" eliminates ${bySink[best!].count} of ${vulnerablePaths.length} vulnerable paths.`,
    };
  }
  return { summary, vulnerablePaths, recommendedFix };
}

export default async function handler(req: Request, ctx: any): Promise<Response> {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: { message: "Use POST" } }), { status: 405, headers: cors });

  const runId = (ctx.user?.id?.slice(0, 4) || "anon") + "-" + Date.now().toString(36);
  const log = (stage: string, data?: any) => console.log(JSON.stringify({ runId, fn: "apply-fix", stage, ...(data || {}) }));
  const fail = (status: number, stage: string, message: string, extra?: any) => {
    log("error", { stage, message });
    return new Response(JSON.stringify({ error: { stage, message, ...(extra || {}) }, runId }), { status, headers: cors });
  };

  try {
    log("start");
    if (!ctx.user) return fail(401, "auth", "Sign in required.");
    const userId = ctx.user.id;

    let body: any;
    try { body = await req.json(); } catch { return fail(400, "parse", "Request body is not valid JSON."); }

    let config = body.config;
    const scanId = body.scanId || null;
    if (!config && scanId) {
      const row = await ctx.db.query("SELECT config FROM scans WHERE id = $1", [scanId]);
      if (!row.rows?.[0]) return fail(404, "load", `No scan found for scanId ${scanId}.`);
      config = row.rows[0].config;
      log("loaded-config", { scanId });
    }
    if (!config || !Array.isArray(config.tools) || config.tools.length === 0)
      return fail(400, "validate", "Provide a 'config' with a non-empty tools array, or a valid 'scanId'.");
    if (!config.guards) config.guards = [];

    // Determine the guard to add.
    const src = body.guard || body.recommendedFix || body.fix || null;
    let guardToAdd: any;
    if (src) {
      guardToAdd = { guard: src.guard || src.name || "human_approval", placement: src.placement ?? src.at ?? src.on ?? null };
    } else {
      // fall back to the config's own recommended fix
      const rec = runScan(classify(config), config).recommendedFix;
      if (!rec) return fail(400, "fix", "No guard supplied and nothing to fix — config has no vulnerable paths.");
      guardToAdd = { guard: rec.guard, placement: rec.placement };
    }
    log("guard", guardToAdd);

    // Before (original config).
    const before = runScan(classify(config), config);

    // After (guard added).
    const newConfig = { ...config, guards: [...config.guards, guardToAdd] };
    const graph = classify(newConfig);
    const after = runScan(graph, newConfig);
    log("rescan:done", { before: before.summary.vulnerablePaths, after: after.summary.vulnerablePaths });

    // Store the applyfix run.
    const ins = await ctx.db.query(
      "INSERT INTO scans (user_id, agent_name, config, graph, results, kind, parent_scan_id) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,'applyfix',$6) RETURNING id",
      [userId, newConfig.agent || null, JSON.stringify(newConfig), JSON.stringify(graph), JSON.stringify(after), scanId]
    );
    log("stored", { scanId: ins.rows?.[0]?.id });

    return new Response(JSON.stringify({
      scanId: ins.rows?.[0]?.id,
      guardAdded: guardToAdd,
      before: { vulnerablePaths: before.summary.vulnerablePaths },
      after,
      pathsEliminated: before.summary.vulnerablePaths - after.summary.vulnerablePaths,
      config: newConfig,
    }), { status: 200, headers: cors });
  } catch (e: any) {
    return fail(500, "unhandled", e?.message || String(e));
  }
}
