import type { Env } from "./types";
const enc = new TextEncoder();
export function assertTestStripe(env: Env) {
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.startsWith("sk_test_"))
    throw new Error("stripe_live_key_rejected");
}
async function hmac(secret: string, data: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return [
    ...new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))),
  ]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
const safeEqual = (a: string, b: string) => {
  if (a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
};
export async function verifyStripe(
  raw: string,
  header: string,
  secret: string,
  now = Math.floor(Date.now() / 1000),
) {
  if (!secret) return false;
  const parts = header.split(",").map((x) => {
    const i = x.indexOf("=");
    return i < 1 ? [x, ""] : [x.slice(0, i), x.slice(i + 1)];
  });
  const t = parts.find((x) => x[0] === "t")?.[1];
  const sigs = parts.filter((x) => x[0] === "v1" && x[1]).map((x) => x[1]);
  if (
    !t ||
    !/^[0-9]+$/.test(t) ||
    Math.abs(now - Number(t)) > 300 ||
    !sigs.length
  )
    return false;
  const expected = await hmac(secret, `${t}.${raw}`);
  return sigs.some((x) => safeEqual(x, expected));
}
export function parseStripeEvent(raw: string) {
  try {
    const value = JSON.parse(raw) as unknown;
    if (!value || typeof value !== "object") return null;
    const { id, type } = value as Record<string, unknown>;
    return typeof id === "string" &&
      /^evt_[A-Za-z0-9_]+$/.test(id) &&
      id.length <= 255 &&
      typeof type === "string" &&
      type.length > 0 &&
      type.length <= 255
      ? { id, type }
      : null;
  } catch {
    return null;
  }
}
export async function checkout(env: Env, origin: string) {
  assertTestStripe(env);
  if (
    env.STRIPE_ENABLED !== "true" ||
    !env.STRIPE_SECRET_KEY ||
    !env.STRIPE_PRICE_ID
  )
    return new Response(JSON.stringify({ error: "billing_disabled" }), {
      status: 503,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  const body = new URLSearchParams({
    mode: "payment",
    "line_items[0][price]": env.STRIPE_PRICE_ID,
    "line_items[0][quantity]": "1",
    success_url: `${origin}/?checkout=success`,
    cancel_url: `${origin}/?checkout=cancel`,
  });
  const r = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "content-type": "application/x-www-form-urlencoded",
      "stripe-version": "2026-02-25.clover",
    },
    body,
  });
  if (!r.ok)
    return new Response(JSON.stringify({ error: "checkout_failed" }), {
      status: 502,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  const j = await r.json<{ url: string }>();
  return Response.json(
    { url: j.url },
    { headers: { "cache-control": "no-store" } },
  );
}
export async function webhook(req: Request, env: Env) {
  assertTestStripe(env);
  const headers = { "cache-control": "no-store" };
  if (!env.STRIPE_WEBHOOK_SECRET)
    return new Response("disabled", { status: 503, headers });
  const raw = await req.text();
  if (
    !(await verifyStripe(
      raw,
      req.headers.get("stripe-signature") || "",
      env.STRIPE_WEBHOOK_SECRET,
    ))
  )
    return new Response("bad signature", { status: 400, headers });
  const e = parseStripeEvent(raw);
  if (!e) return new Response("bad event", { status: 400, headers });
  await env.DB.prepare(
    "INSERT OR IGNORE INTO billing_events(event_id,event_type,status,created_at) VALUES(?,?,?,?)",
  )
    .bind(e.id, e.type, "received", Math.floor(Date.now() / 1000))
    .run();
  return Response.json({ received: true }, { headers });
}
