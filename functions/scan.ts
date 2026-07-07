// Redline — orchestration spine (Butterbase serverless function)
// Endpoint: POST /v1/{app_id}/fn/scan
//
// Sequence: validate Config -> paywall check -> RocketRide /classify -> Graph
//   -> Person A scan(graph) -> Results -> RocketRide /explain per path
//   -> store in Butterbase -> return the full Results shape.
//
// Every external call is MOCKED locally until the real endpoint URL is set as
// an env var. Swapping a mock for a real call is a one-line change: set the
// corresponding *_URL env var and the fetch path takes over. Every stage logs.
//
// This file is plain JS (Deno) so the deployed function == this source.

const FREE_SCAN_LIMIT = 1;

// ------------------------- classification heuristics -------------------------
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

// ------------------------- guard normalization -------------------------
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

// ------------------------- STAGE 1: classify (RocketRide /classify) -------------------------
async function classify(config, env, log) {
  const url = env.ROCKETRIDE_CLASSIFY_URL;
  if (url) {
    log("classify:real", { url });
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.ROCKETRIDE_API_KEY || ""}` },
      body: JSON.stringify(config),
    });
    if (!r.ok) throw new Error(`RocketRide /classify ${r.status}: ${await r.text()}`);
    const j = await r.json();
    return j.graph ?? j; // accept { graph: {...} } or a bare Graph
  }
  log("classify:mock");
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

// ------------------------- STAGE 2: scan (Person A graph scan) -------------------------
async function runScan(graph, config, env, log) {
  const url = env.SCAN_URL;
  if (url) {
    log("scan:real", { url });
    // Agreed contract (Person A + Person C specs): the orchestrator sends the
    // WRAPPED form { graph } and expects a bare Results back. Person A's /scan
    // also accepts a bare Graph, but { graph } is the documented contract.
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ graph }),
    });
    if (!r.ok) throw new Error(`scan(graph) ${r.status}: ${await r.text()}`);
    const j = await r.json();
    return j.results ?? j; // bare Results expected; tolerate { results: {...} } too
  }
  log("scan:mock");
  const nodes = graph.nodes || [];
  const guards = normalizeGuards(graph.guards || []);
  const descById = {};
  for (const t of (config.tools || [])) descById[t.name] = t.description || "";
  const sources = nodes.filter((n) => n.role === "source");
  const sinks = nodes.filter((n) => n.role === "sink" && n.privileged);
  const vulnerablePaths = [];
  let idx = 0;
  for (const s of sources) {
    for (const k of sinks) {
      const path = [s.id, "context", k.id];
      const covered = guards.some((g) => guardCoversPath(g, path));
      if (!covered) {
        idx += 1;
        vulnerablePaths.push({ id: `p${idx}`, path, severity: severityForSink(descById[k.id]), explanation: "" });
      }
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
    recommendedFix = { guard: "human_approval", placement: best, pathsEliminated: bySink[best].count, pathsTotal: vulnerablePaths.length, rationale: "" };
  }
  return { summary, vulnerablePaths, recommendedFix };
}

// ------------------------- STAGE 3: explain (RocketRide /explain) -------------------------
async function explain(results, graph, config, env, log) {
  const url = env.ROCKETRIDE_EXPLAIN_URL;
  const descById = {};
  for (const t of (config.tools || [])) descById[t.name] = t.description || "";
  if (url) {
    log("explain:real", { url, paths: results.vulnerablePaths.length });
    for (const vp of results.vulnerablePaths) {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.ROCKETRIDE_API_KEY || ""}` },
        body: JSON.stringify({ path: vp.path, severity: vp.severity, graph }),
      });
      if (!r.ok) throw new Error(`RocketRide /explain ${r.status}: ${await r.text()}`);
      const data = await r.json();
      vp.explanation = data.explanation ?? vp.explanation;
    }
    // Optional rationale enrichment — sent as { recommendedFix, graph }. Non-fatal if
    // Person B's /explain doesn't recognize it: the templated rationale simply stands.
    if (results.recommendedFix) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${env.ROCKETRIDE_API_KEY || ""}` },
          body: JSON.stringify({ recommendedFix: results.recommendedFix, graph }),
        });
        if (r.ok) { const d = await r.json(); results.recommendedFix.rationale = d.rationale ?? results.recommendedFix.rationale; }
      } catch (_e) { /* keep templated rationale */ }
    }
    return results;
  }
  log("explain:mock", { paths: results.vulnerablePaths.length });
  for (const vp of results.vulnerablePaths) {
    const src = vp.path[0];
    const sink = vp.path[vp.path.length - 1];
    vp.explanation = `Untrusted data from "${src}" (${descById[src] || "external input"}) flows through the agent's shared context into "${sink}" (${descById[sink] || "privileged action"}) with no guard in between. A prompt injection planted in the "${src}" input can coerce the agent into calling "${sink}", triggering a ${vp.severity}-severity action the user never intended.`;
  }
  if (results.recommendedFix) {
    const rf = results.recommendedFix;
    rf.rationale = `Placing a ${rf.guard} check at "${rf.placement}" forces explicit approval before the most dangerous action, eliminating ${rf.pathsEliminated} of ${rf.pathsTotal} vulnerable paths with a single guard.`;
  }
  return results;
}

// ------------------------- paywall -------------------------
async function checkEntitlement(ctx, userId, log) {
  // Explicit user_id filter — robust even if ctx.db weren't RLS-scoped.
  const cnt = await ctx.db.query("SELECT count(*)::int AS n FROM scans WHERE kind = 'scan' AND user_id = $1", [userId]);
  const used = cnt.rows?.[0]?.n ?? 0;
  let entitled = false, plan = "free";
  try {
    const ent = await ctx.db.query("SELECT active, plan FROM entitlements WHERE user_id = $1", [userId]);
    if (ent.rows?.[0]) { entitled = ent.rows[0].active === true; plan = ent.rows[0].plan || "free"; }
  } catch (_e) {}
  const allowed = entitled || used < FREE_SCAN_LIMIT;
  log("paywall", { used, freeLimit: FREE_SCAN_LIMIT, entitled, plan, allowed });
  return { allowed, used, entitled, plan };
}

// ------------------------- handler -------------------------
export default async function handler(req, ctx) {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: { message: "Use POST" } }), { status: 405, headers: cors });

  const runId = (ctx.user?.id?.slice(0, 4) || "anon") + "-" + Date.now().toString(36);
  const log = (stage, data) => console.log(JSON.stringify({ runId, fn: "scan", stage, ...(data || {}) }));
  const fail = (status, stage, message, extra) => {
    log("error", { stage, message, ...(extra || {}) });
    return new Response(JSON.stringify({ error: { stage, message, ...(extra || {}) }, runId }), { status, headers: cors });
  };

  try {
    log("start", { method: req.method });
    if (!ctx.user) return fail(401, "auth", "Sign in required. No authenticated user on this request.");
    const userId = ctx.user.id;

    let config;
    try { config = await req.json(); } catch { return fail(400, "parse", "Request body is not valid JSON."); }
    if (!config || !Array.isArray(config.tools) || config.tools.length === 0) return fail(400, "validate", "Config must include a non-empty 'tools' array.");
    if (!config.guards) config.guards = [];
    log("config", { agent: config.agent, tools: config.tools.length, guards: config.guards.length });

    const ent = await checkEntitlement(ctx, userId, log);
    if (!ent.allowed) {
      // 402 exposes upgrade fields BOTH nested in error and at top level, so the
      // frontend can read either error.upgradeRequired or upgradeRequired.
      const message = `Free tier allows ${FREE_SCAN_LIMIT} scan. You've used ${ent.used}. Upgrade to run unlimited scans.`;
      log("error", { stage: "paywall", message, used: ent.used, upgradeRequired: true });
      return new Response(JSON.stringify({
        error: { stage: "paywall", message, used: ent.used, freeLimit: FREE_SCAN_LIMIT, plan: ent.plan, upgradeRequired: true },
        upgradeRequired: true, used: ent.used, freeLimit: FREE_SCAN_LIMIT, plan: ent.plan, runId,
      }), { status: 402, headers: cors });
    }

    const graph = await classify(config, ctx.env, log);
    log("classify:done", { nodes: graph.nodes?.length, edges: graph.edges?.length });

    let results = await runScan(graph, config, ctx.env, log);
    log("scan:done", { vulnerablePaths: results.summary?.vulnerablePaths });

    results = await explain(results, graph, config, ctx.env, log);
    log("explain:done");

    const ins = await ctx.db.query(
      "INSERT INTO scans (user_id, agent_name, config, graph, results, kind) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5::jsonb, 'scan') RETURNING id, created_at",
      [userId, config.agent || null, JSON.stringify(config), JSON.stringify(graph), JSON.stringify(results)]
    );
    const scanId = ins.rows?.[0]?.id;
    log("stored", { scanId });

    return new Response(JSON.stringify({ scanId, ...results }), { status: 200, headers: cors });
  } catch (e) {
    return fail(500, "unhandled", e?.message || String(e), { stack: e?.stack });
  }
}
