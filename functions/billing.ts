// Redline — billing / paywall unlock (Butterbase serverless function)
// Endpoint: POST /v1/{app_id}/fn/billing   body: { action: "status" | "checkout" | "confirm", ... }
//
// Free tier = 1 scan (enforced in scan.ts). Paid = unlimited, gated by the
// entitlements table. This function drives the purchase that flips
// entitlements.active = true.
//
// Payment mode is swappable, exactly like the RocketRide mocks:
//   - If ctx.env.STRIPE_SECRET_KEY is set, "checkout" creates a REAL Stripe
//     test-mode Checkout Session and "confirm" only grants after Stripe reports
//     payment_status = "paid".
//   - If not set, it runs in MOCK mode: "checkout" returns a mock URL and
//     "confirm" grants immediately, so the unlock is provable end-to-end today.
//
// Set STRIPE_SECRET_KEY (sk_test_...) via redeploy envVars to go live.

const PRICE_CENTS = 900;          // $9.00 test charge
const PLAN_NAME = "Redline Pro";

async function getStatus(ctx: any, userId: string) {
  const cnt = await ctx.db.query("SELECT count(*)::int AS n FROM scans WHERE kind = 'scan'");
  const used = cnt.rows?.[0]?.n ?? 0;
  let entitled = false, plan = "free";
  const ent = await ctx.db.query("SELECT active, plan FROM entitlements WHERE user_id = $1", [userId]);
  if (ent.rows?.[0]) { entitled = ent.rows[0].active === true; plan = ent.rows[0].plan || "free"; }
  return { plan, active: entitled, used, freeLimit: 1, unlimited: entitled };
}

// Grant the entitlement (upsert without relying on a unique constraint —
// Butterbase's schema DSL did not emit a PK on user_id). Runs from confirm/webhook.
async function grant(ctx: any, userId: string, source: string) {
  const existing = await ctx.db.query("SELECT 1 FROM entitlements WHERE user_id = $1 LIMIT 1", [userId]);
  if (existing.rows?.length) {
    await ctx.db.query("UPDATE entitlements SET plan='pro', active=true, source=$2, updated_at=now() WHERE user_id=$1", [userId, source]);
  } else {
    await ctx.db.query("INSERT INTO entitlements (user_id, plan, active, source, updated_at) VALUES ($1,'pro',true,$2,now())", [userId, source]);
  }
}

function stripeForm(obj: Record<string, string>) {
  return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
}

export default async function handler(req: Request, ctx: any): Promise<Response> {
  const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "POST, OPTIONS", "Content-Type": "application/json" };
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: { message: "Use POST" } }), { status: 405, headers: cors });

  const runId = (ctx.user?.id?.slice(0, 4) || "anon") + "-" + Date.now().toString(36);
  const log = (stage: string, data?: any) => console.log(JSON.stringify({ runId, fn: "billing", stage, ...(data || {}) }));
  const fail = (status: number, stage: string, message: string) => {
    log("error", { stage, message });
    return new Response(JSON.stringify({ error: { stage, message }, runId }), { status, headers: cors });
  };
  const ok = (data: any) => new Response(JSON.stringify({ ...data, runId }), { status: 200, headers: cors });

  try {
    if (!ctx.user) return fail(401, "auth", "Sign in required.");
    const userId = ctx.user.id;
    let body: any = {};
    try { body = await req.json(); } catch { /* status has no body */ }
    const action = body.action || "status";
    const stripeKey = ctx.env.STRIPE_SECRET_KEY;
    const mock = !stripeKey;
    log("start", { action, mode: mock ? "mock" : "stripe-test" });

    if (action === "status") {
      return ok({ ...(await getStatus(ctx, userId)), paymentMode: mock ? "mock" : "stripe-test" });
    }

    if (action === "checkout") {
      const successUrl = body.successUrl || "https://redline.butterbase.dev/?paid=1";
      const cancelUrl = body.cancelUrl || "https://redline.butterbase.dev/?canceled=1";
      if (mock) {
        // MOCK: no real charge. Front end calls confirm to complete the "purchase".
        log("checkout:mock");
        return ok({ mode: "mock", plan: PLAN_NAME, amountCents: PRICE_CENTS,
          url: `${successUrl}${successUrl.includes("?") ? "&" : "?"}mock_session=${userId}`,
          note: "MOCK payment mode. Call billing {action:'confirm'} to unlock. Set STRIPE_SECRET_KEY to charge for real." });
      }
      // REAL Stripe test-mode Checkout Session.
      log("checkout:stripe");
      const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
        method: "POST",
        headers: { "Authorization": `Bearer ${stripeKey}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: stripeForm({
          "mode": "payment",
          "success_url": `${successUrl}${successUrl.includes("?") ? "&" : "?"}session_id={CHECKOUT_SESSION_ID}`,
          "cancel_url": cancelUrl,
          "client_reference_id": userId,
          "metadata[user_id]": userId,
          "line_items[0][price_data][currency]": "usd",
          "line_items[0][price_data][product_data][name]": PLAN_NAME,
          "line_items[0][price_data][unit_amount]": String(PRICE_CENTS),
          "line_items[0][quantity]": "1",
        }),
      });
      const data = await r.json();
      if (!r.ok) return fail(502, "checkout", `Stripe error: ${JSON.stringify(data.error || data)}`);
      return ok({ mode: "stripe-test", url: data.url, sessionId: data.id });
    }

    if (action === "confirm") {
      if (mock) {
        log("confirm:mock-grant");
        await grant(ctx, userId, "mock");
        return ok({ granted: true, mode: "mock", ...(await getStatus(ctx, userId)) });
      }
      // REAL: verify the session is paid before granting.
      const sessionId = body.sessionId;
      if (!sessionId) return fail(400, "confirm", "sessionId required to confirm a Stripe payment.");
      const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
        headers: { "Authorization": `Bearer ${stripeKey}` },
      });
      const s = await r.json();
      if (!r.ok) return fail(502, "confirm", `Stripe error: ${JSON.stringify(s.error || s)}`);
      if (s.payment_status !== "paid") return fail(402, "confirm", `Payment not completed (status: ${s.payment_status}).`);
      if (s.client_reference_id && s.client_reference_id !== userId) return fail(403, "confirm", "Session belongs to a different user.");
      log("confirm:stripe-grant", { sessionId });
      await grant(ctx, userId, "stripe-test");
      return ok({ granted: true, mode: "stripe-test", ...(await getStatus(ctx, userId)) });
    }

    return fail(400, "action", `Unknown action "${action}". Use status | checkout | confirm.`);
  } catch (e: any) {
    return fail(500, "unhandled", e?.message || String(e));
  }
}
