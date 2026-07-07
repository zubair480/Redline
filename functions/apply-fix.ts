// Redline — apply-fix loop (Butterbase serverless function)
// Endpoint: POST /v1/{app_id}/fn/apply-fix
//
// Takes a Config + a recommended guard, adds the guard, reruns the scan, and
// returns before/after so the UI can show "red goes green". Not paywalled.
//
// Body: { config?, scanId?, guard? | recommendedFix? | fix? }
//   - Provide `config` inline, or `scanId` to load the original config from history.
//   - Provide the guard to add as `guard` ({guard|name, placement}) or a full
//     `recommendedFix`/`fix`. If omitted, the scan's own recommendedFix is used.
//
// The classify/scan/explain pipeline mirrors scan.ts EXACTLY, including the
// env-var mock->real swap, so before/after numbers stay consistent with a live
// scan once SCAN_URL / ROCKETRIDE_* are set. When a `scanId` is passed, the
// "before" count is read from the STORED scan result (the source of truth for
// what the user actually saw) rather than recomputed. Duplication is deliberate:
// Butterbase functions are isolated single files and cannot import each other —
// keep this pipeline in sync with scan.ts.

const GUARD_KW = ["approv", "verify", "confirm", "human", "review", "sanitiz",
  "moderat", "allowlist", "whitelist", "guard", "permission check", "validate input"];
const SINK_KW = ["refund", "payment", "pay ", "transfer", "send", "delete", "remove",
  "execute", "run command", "deploy", "purchase", "charge", "issue", "publish",
  "post ", "write", "modify", "wire", "provision", "grant", "email a", "reply"];
const SOURCE_KW = ["read", "incoming", "customer-provided", "fetch", "url", "external",
  "scrape", "download", "receive", "inbox", "message", "comment", "ticket", "upload",
  "webhook", "user input", "untrusted", "browse"];
const CRITICAL_KW = ["refund", "payment", "pay", "transfer", "charge", "wire", "delete",
  "remove", "execute", "deploy", "purchase", "grant", "provision"];
const HIGH_KW = ["send", "email", "post", "publish", "write", "modify", "message", "reply"];

function anyKw(text, kws) {
  const t = " " + (text || "").toLowerCase() + " ";
  return kws.some((k) => t.includes(k));
}
function classifyRole(desc) {
  const d = desc || "";
  if (anyKw(d, GUARD_KW)) return { role: "guard", privileged: false };
  if (anyKw(d, SINK_KW)) return { role: "sink", privileged: true };
  if (anyKw(d, SOURCE_KW)) return { role: "source", privileged: false };
  return { role: "passthrough", privileged: false };
}
function severityForSink(desc) {
  if (anyKw(desc || "", CRITICAL_KW)) return "critical";
  if (anyKw(desc || "", HIGH_KW)) return "high";
  return "medium";
}
const SEV_RANK = { critical: 3, high: 2, medium: 1, low: 0 };

function normalizeGuards(guards) {
  if (!Array.isArray(guards)) return [];
  return guards.map((g) => {
    if (typeof g === "string") return { name: g, placement: null };
    return { name: g.guard || g.name || g.id || "guard", placement: g.placement ?? g.at ?? g.on ?? null };
  });
}
function guardCoversPath(guard, path) {
  const p = guard.placement;
  if (p === null || p === "*" || p === "all") return true;
  return path.includes(p);
}

// ---- pipeline (identical semantics to scan.ts) ----
async function classify(config, env, log) {
  const url = env.ROCKETRIDE_CLASSIFY_URL;
  if (url) {
    log("classify:real", { url });
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.ROCKETRIDE_API_KEY || ""}` }, body: JSON.stringify(config) });
    if (!r.ok) throw new Error(`RocketRide /classify ${r.status}: ${await r.text()}`);
    const j = await r.json();
    return j.graph ?? j;
  }
  const tools = Array.isArray(config.tools) ? config.tools : [];
  const nodes = tools.map((t) => {
    const { role, privileged } = classifyRole(t.description);
    return { id: t.name, role, privileged,
      rationale: role === "source" ? `Ingests untrusted external input: "${t.description}"`
        : role === "sink" ? `Performs a privileged action: "${t.description}"`
        : role === "guard" ? `Acts as a safety check: "${t.description}"`
        : `Internal / low-risk operation: "${t.description}"` };
  });
  const sources = nodes.filter((n) => n.role === "source");
  const sinks = nodes.filter((n) => n.role === "sink");
  const edges = [];
  for (const s of sources) for (const k of sinks) edges.push({ from: s.id, via: "context", to: k.id });
  return { nodes, edges, guards: normalizeGuards(config.guards) };
}

async function runScan(graph, config, env, log) {
  const url = env.SCAN_URL;
  if (url) {
    log("scan:real", { url });
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(graph) });
    if (!r.ok) throw new Error(`scan(graph) ${r.status}: ${await r.text()}`);
    const j = await r.json();
    return j.results ?? j;
  }
  const nodes = graph.nodes || [];
  const guards = normalizeGuards(graph.guards || []);
  const descById = {};
  for (const t of (config.tools || [])) descById[t.name] = t.description || "";
  const sources = nodes.filter((n) => n.role === "source");
  const sinks = nodes.filter((n) => n.role === "sink" && n.privileged);
  const vulnerablePaths = [];
  let idx = 0;
  for (const s of sources) for (const k of sinks) {
    const path = [s.id, "context", k.id];
    if (!guards.some((g) => guardCoversPath(g, path))) {
      idx += 1;
      vulnerablePaths.push({ id: `p${idx}`, path, severity: severityForSink(descById[k.id]),
        explanation: `Untrusted data from "${s.id}" (${descById[s.id] || "external input"}) flows through the agent's shared context into "${k.id}" (${descById[k.id] || "privileged action"}) with no guard in between.` });
    }
  }
  const summary = { sources: sources.length, sinks: sinks.length, guards: guards.length, vulnerablePaths: vulnerablePaths.length };
  let recommendedFix = null;
  if (vulnerablePaths.length > 0) {
    const bySink = {};
    for (const vp of vulnerablePaths) {
      const sink = vp.path[vp.path.length - 1];
      if (!bySink[sink]) bySink[sink] = { count: 0, sev: vp.severity };
      bySink[sink].count += 1;
      if (SEV_RANK[vp.severity] > SEV_RANK[bySink[sink].sev]) bySink[sink].sev = vp.severity;
    }
    let best = null;
    for (const sink of Object.keys(bySink)) {
      if (best === null || bySink[sink].count > bySink[best].count ||
        (bySink[sink].count === bySink[best].count && SEV_RANK[bySink[sink].sev] > SEV_RANK[bySink[best].sev])) best = sink;
    }
    recommendedFix = { guard: "human_approval", placement: best, pathsEliminated: bySink[best].count, pathsTotal: vulnerablePaths.length,
      rationale: `Placing a human_approval check at "${best}" eliminates ${bySink[best].count} of ${vulnerablePaths.length} vulnerable paths.` };
  }
  return { summary, vulnerablePaths, recommendedFix };
}

async function explain(results, graph, config, env, log) {
  const url = env.ROCKETRIDE_EXPLAIN_URL;
  if (!url) return results; // mock explanations are already inlined by runScan
  log("explain:real", { url, paths: results.vulnerablePaths.length });
  for (const vp of results.vulnerablePaths) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.ROCKETRIDE_API_KEY || ""}` }, body: JSON.stringify({ path: vp.path, severity: vp.severity, graph }) });
    if (!r.ok) throw new Error(`RocketRide /explain ${r.status}: ${await r.text()}`);
    const data = await r.json();
    vp.explanation = data.explanation ?? vp.explanation;
  }
  if (results.recommendedFix) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.ROCKETRIDE_API_KEY || ""}` }, body: JSON.stringify({ recommendedFix: results.recommendedFix, graph }) });
      if (r.ok) { const d = await r.json(); results.recommendedFix.rationale = d.rationale ?? results.recommendedFix.rationale; }
    } catch (_e) {}
  }
  return results;
}

export default async function handler(req, ctx) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: { message: "Use POST" } }), { status: 405, headers: cors });

  const runId = (ctx.user?.id?.slice(0, 4) || "anon") + "-" + Date.now().toString(36);
  const log = (stage, data) => console.log(JSON.stringify({ runId, fn: "apply-fix", stage, ...(data || {}) }));
  const fail = (status, stage, message, extra) => {
    log("error", { stage, message });
    return new Response(JSON.stringify({ error: { stage, message, ...(extra || {}) }, runId }), { status, headers: cors });
  };

  try {
    log("start");
    if (!ctx.user) return fail(401, "auth", "Sign in required.");
    const userId = ctx.user.id;

    let body;
    try { body = await req.json(); } catch { return fail(400, "parse", "Request body is not valid JSON."); }

    let config = body.config;
    let storedResults = null;
    const scanId = body.scanId || null;
    if (scanId) {
      const row = await ctx.db.query("SELECT config, results FROM scans WHERE id = $1", [scanId]);
      if (!row.rows?.[0]) return fail(404, "load", `No scan found for scanId ${scanId}.`);
      if (!config) config = row.rows[0].config;
      storedResults = row.rows[0].results || null;
      log("loaded", { scanId });
    }
    if (!config || !Array.isArray(config.tools) || config.tools.length === 0)
      return fail(400, "validate", "Provide a 'config' with a non-empty tools array, or a valid 'scanId'.");
    if (!config.guards) config.guards = [];

    // Determine the guard to add: explicit body value -> stored recommendedFix -> compute one.
    const src = body.guard || body.recommendedFix || body.fix || null;
    let guardToAdd;
    if (src) {
      guardToAdd = { guard: src.guard || src.name || "human_approval", placement: src.placement ?? src.at ?? src.on ?? null };
    } else if (storedResults?.recommendedFix) {
      const rec = storedResults.recommendedFix;
      guardToAdd = { guard: rec.guard, placement: rec.placement };
    } else {
      const rec = (await runScan(await classify(config, ctx.env, log), config, ctx.env, log)).recommendedFix;
      if (!rec) return fail(400, "fix", "No guard supplied and nothing to fix — config has no vulnerable paths.");
      guardToAdd = { guard: rec.guard, placement: rec.placement };
    }
    log("guard", guardToAdd);

    // "before" = the stored result the user saw, if we have it; otherwise compute it.
    let beforeCount;
    if (storedResults?.summary) {
      beforeCount = storedResults.summary.vulnerablePaths;
    } else {
      const before = await runScan(await classify(config, ctx.env, log), config, ctx.env, log);
      beforeCount = before.summary.vulnerablePaths;
    }

    // "after" = full rerun through the same pipeline with the guard added.
    const newConfig = { ...config, guards: [...config.guards, guardToAdd] };
    const graph = await classify(newConfig, ctx.env, log);
    let after = await runScan(graph, newConfig, ctx.env, log);
    after = await explain(after, graph, newConfig, ctx.env, log);
    log("rescan:done", { before: beforeCount, after: after.summary.vulnerablePaths });

    const ins = await ctx.db.query(
      "INSERT INTO scans (user_id, agent_name, config, graph, results, kind, parent_scan_id) VALUES ($1,$2,$3::jsonb,$4::jsonb,$5::jsonb,'applyfix',$6) RETURNING id",
      [userId, newConfig.agent || null, JSON.stringify(newConfig), JSON.stringify(graph), JSON.stringify(after), scanId]
    );
    log("stored", { scanId: ins.rows?.[0]?.id });

    return new Response(JSON.stringify({
      scanId: ins.rows?.[0]?.id,
      guardAdded: guardToAdd,
      before: { vulnerablePaths: beforeCount },
      after,
      pathsEliminated: beforeCount - after.summary.vulnerablePaths,
      config: newConfig,
    }), { status: 200, headers: cors });
  } catch (e) {
    return fail(500, "unhandled", e?.message || String(e));
  }
}
