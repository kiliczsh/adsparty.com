import { Station } from "./station-do";
import { MediaPackager } from "./media-container";
import {
  adminClipActionAllowed,
  adminMessageActionAllowed,
  cleanMessage,
  constantTimeEqual,
  falQueueRequestUrl,
  generationDuration,
  hardReject,
  packagingClaimable,
  policyReject,
  providerGenerationDuration,
  promptDuration,
  sourceVideoDuration,
  videoProvider,
  validAdminBearer,
  validClipId,
  validMessage,
  validNick,
  validSegment,
  type Policy,
} from "./core";
import { assertTestStripe, checkout, webhook } from "./billing";
import type { Env, GenerationMessage } from "./types";
import {
  getWiroTaskDetail,
  submitWiroTask,
  wiroRunInput,
  wiroTaskState,
  wiroVideoOutput,
} from "./wiro";
export { Station, MediaPackager };
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
};
const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...headers },
  });
const station = (env: Env) => env.STATION.getByName("live");
const method = (req: Request, allowed: string[]) =>
  allowed.includes(req.method)
    ? null
    : new Response("Method Not Allowed", {
        status: 405,
        headers: { allow: allowed.join(", ") },
      });
const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
let ephemeralViewerKey: string | undefined;
async function signViewer(value: string, env: Env) {
  const secret =
    env.VIEWER_SIGNING_KEY ||
    env.ADMIN_TOKEN ||
    env.TURNSTILE_SECRET_KEY ||
    (ephemeralViewerKey ??= crypto.randomUUID());
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)),
  );
}
async function viewer(req: Request, env: Env) {
  const existing = req.headers
    .get("cookie")
    ?.match(/(?:^|; )tv_viewer=([a-f0-9]{32})\.([a-f0-9]{64})(?:;|$)/);
  if (
    existing &&
    constantTimeEqual(await signViewer(existing[1], env), existing[2])
  )
    return { id: existing[1], token: existing[0].split("=")[1], fresh: false };
  const id = crypto.randomUUID().replaceAll("-", "");
  const signature = await signViewer(id, env);
  return { id, token: `${id}.${signature}`, fresh: true };
}
const viewerCookie = (token: string) =>
  `tv_viewer=${token}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`;
let repeatLikesReady = false;
async function ensureRepeatLikes(env: Env) {
  if (repeatLikesReady) return;
  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS like_events (id INTEGER PRIMARY KEY AUTOINCREMENT,clip_id INTEGER NOT NULL,viewer_id TEXT NOT NULL,created_at INTEGER NOT NULL,FOREIGN KEY(clip_id) REFERENCES clips(id))",
  ).run();
  await env.DB.prepare(
    "CREATE INDEX IF NOT EXISTS idx_like_events_clip_id ON like_events(clip_id,id)",
  ).run();
  repeatLikesReady = true;
}
async function networkRateKey(req: Request, env: Env) {
  const source = req.headers.get("cf-connecting-ip") || "unknown";
  return (await signViewer(`network:${source}`, env)).slice(0, 32) || "unknown";
}
function secureHeaders(h: Headers) {
  h.set("x-content-type-options", "nosniff");
  h.set("referrer-policy", "strict-origin-when-cross-origin");
  h.set("permissions-policy", "camera=(), microphone=(), geolocation=()");
  h.set("x-frame-options", "DENY");
  h.set(
    "content-security-policy",
    "default-src 'self'; media-src 'self' blob: https://*.fal.media; script-src 'self' https://cdn.jsdelivr.net https://challenges.cloudflare.com https://www.googletagmanager.com; worker-src 'self' blob:; frame-src https://challenges.cloudflare.com; connect-src 'self' https://*.fal.media https://challenges.cloudflare.com https://cdn.jsdelivr.net https://www.google-analytics.com https://region1.google-analytics.com; style-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  );
}
function finalize(req: Request, r: Response) {
  const headers = new Headers(r.headers);
  secureHeaders(headers);
  const path = new URL(req.url).pathname;
  if (
    path.startsWith("/api/") ||
    path === "/status.json" ||
    path.endsWith(".m3u8") ||
    path.endsWith("meta.json")
  )
    headers.set("cache-control", "no-store");
  return new Response(r.body, {
    status: r.status,
    statusText: r.statusText,
    headers,
  });
}
async function body(req: Request) {
  if (
    !(req.headers.get("content-type") || "")
      .toLowerCase()
      .startsWith("application/json")
  )
    throw json({ error: "json_required" }, 415);
  const len = Number(req.headers.get("content-length") || 0);
  if (len > 4096) throw json({ error: "body_too_large" }, 413);
  const text = await req.text();
  if (text.length > 4096) throw json({ error: "body_too_large" }, 413);
  try {
    return JSON.parse(text);
  } catch {
    throw json({ error: "invalid_json" }, 400);
  }
}
async function policy(env: Env) {
  const row = await env.DB.prepare(
    "SELECT value FROM settings WHERE key='policy'",
  ).first<string>("value");
  return JSON.parse(row || "{}") as Policy;
}
async function turnstile(token: string, req: Request, env: Env) {
  if (!env.TURNSTILE_SECRET_KEY) return false;
  const r = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        remoteip: req.headers.get("cf-connecting-ip"),
        idempotency_key: crypto.randomUUID(),
      }),
    },
  );
  return (await r.json<{ success: boolean }>()).success;
}
async function chat(req: Request, env: Env) {
  const bad = method(req, ["GET", "POST"]);
  if (bad) return bad;
  const v = await viewer(req, env);
  if (req.method === "GET") {
    const u = new URL(req.url);
    const rawSince = u.searchParams.get("since") || "0";
    const since = /^\d+$/.test(rawSince)
      ? Math.min(Number(rawSince), Number.MAX_SAFE_INTEGER)
      : 0;
    const mine = (u.searchParams.get("mine") || "")
      .split(",")
      .filter((x) => /^\d+$/.test(x))
      .slice(0, 50)
      .map(Number);
    const q = since
      ? "SELECT id,user,msg,created_at,status FROM messages WHERE id>? ORDER BY id LIMIT 50"
      : "SELECT * FROM (SELECT id,user,msg,created_at,status FROM messages ORDER BY id DESC LIMIT 50) ORDER BY id";
    const msgs = await env.DB.prepare(q)
      .bind(...(since ? [since] : []))
      .all();
    let states: null | Record<string, string> = null;
    if (mine.length) {
      const rows = await env.DB.prepare(
        `SELECT id,status FROM messages WHERE id IN (${mine.map(() => "?").join(",")})`,
      )
        .bind(...mine)
        .all<any>();
      states = Object.fromEntries(
        rows.results.map((x) => [String(x.id), x.status]),
      );
    }
    const st = await station(env).fetch(
      new Request("https://station/status", {
        headers: { "x-viewer-id": v.id },
      }),
    );
    const sj = await st.json<any>();
    return json(
      { msgs: msgs.results, mine: states, viewers: Number(sj.viewers) || 0 },
      200,
      v.fresh ? { "set-cookie": viewerCookie(v.token) } : {},
    );
  }
  const x = (await body(req)) as any;
  const msg = cleanMessage(x.msg);
  if (!validNick(x.user) || !validMessage(msg))
    return json({ error: "invalid_chat" }, 400);
  if (!(await turnstile(String(x.cf_token || ""), req, env)))
    return json({ error: "verification_failed" }, 403);
  const key = `rate:chat:${await networkRateKey(req, env)}`;
  const rate = await station(env).fetch(
    new Request(`https://station/rate?key=${encodeURIComponent(key)}`),
  );
  if (rate.status === 429) return json({ error: "rate_limited" }, 429);
  const cooldown = await station(env).fetch(
    new Request(
      `https://station/rate?key=${encodeURIComponent(`chat-viewer:${v.id}`)}&limit=1&window=60000`,
    ),
  );
  if (cooldown.status === 429)
    return json({ error: "cooldown", retry_after: 60 }, 429);
  const p = await policy(env);
  const rejection = hardReject(msg) ? "hard_reject" : policyReject(msg, p);
  const now = Math.floor(Date.now() / 1000);
  const status = rejection ? "rejected" : "queued";
  const result = await env.DB.prepare(
    "INSERT INTO messages(user,msg,created_at,status,rejection_code) VALUES(?,?,?,?,?) RETURNING id",
  )
    .bind(x.user, msg, now, status, rejection)
    .first<any>();
  console.log(
    JSON.stringify({
      event: rejection ? "chat_rejected" : "chat_accepted",
      message_id: result.id,
      code: rejection || undefined,
    }),
  );
  return json({ id: result.id, status }, 201, {
    "set-cookie": viewerCookie(v.token),
  });
}
async function likes(req: Request, env: Env) {
  const bad = method(req, ["GET", "POST"]);
  if (bad) return bad;
  const input =
    req.method === "GET"
      ? Object.fromEntries(new URL(req.url).searchParams)
      : ((await body(req)) as Record<string, unknown>);
  const seg = typeof input.seg === "string" ? input.seg : "";
  const rawClipId = input.clip_id ?? input.clip;
  const bySegment = validSegment(seg);
  const byClipId = validClipId(rawClipId);
  if (!bySegment && !byClipId)
    return json({ error: "invalid_like_target" }, 400);
  const target = bySegment ? seg : String(Number(rawClipId));
  const known = await station(env)
    .fetch(
      `https://station/like-target?${bySegment ? "seg" : "clip"}=${encodeURIComponent(target)}`,
    )
    .then((response) => response.json<{ known: boolean }>())
    .then((result) => result.known)
    .catch(() => false);
  if (!known) return json({ likes: 0 });
  const clip = await env.DB.prepare(
    bySegment
      ? "SELECT id FROM clips WHERE segment_filename=?"
      : "SELECT id FROM clips WHERE id=?",
  )
    .bind(bySegment ? seg : Number(rawClipId))
    .first<any>();
  if (!clip) return json({ likes: 0 });
  const v = await viewer(req, env);
  await ensureRepeatLikes(env);
  if (req.method === "POST") {
    const rate = await station(env).fetch(
      new Request(
        `https://station/rate?key=${encodeURIComponent(`like:${v.id}`)}&limit=30`,
      ),
    );
    if (rate.status === 429) return json({ error: "rate_limited" }, 429);
    await env.DB.prepare(
      "INSERT INTO like_events(clip_id,viewer_id,created_at) VALUES(?,?,?)",
    )
      .bind(clip.id, v.id, Math.floor(Date.now() / 1000))
      .run();
  }
  const n = await env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM likes WHERE clip_id=?)+(SELECT COUNT(*) FROM like_events WHERE clip_id=?) n",
  )
    .bind(clip.id, clip.id)
    .first<number>("n");
  return json(
    { likes: n || 0 },
    200,
    req.method === "POST" ? { "set-cookie": viewerCookie(v.token) } : {},
  );
}
function admin(req: Request, env: Env) {
  return validAdminBearer(req.headers.get("authorization"), env.ADMIN_TOKEN);
}
async function handle(req: Request, env: Env) {
  const u = new URL(req.url);
  if (u.hostname === "www.adsparty.com") {
    u.hostname = "adsparty.com";
    return Response.redirect(u.toString(), 308);
  }
  if (u.pathname === "/api/config") {
    const bad = method(req, ["GET"]);
    if (bad) return bad;
    return json({
      brand: env.BRAND_NAME,
      turnstile_site_key: env.TURNSTILE_SITE_KEY,
      chat_enabled: Boolean(env.TURNSTILE_SECRET_KEY),
      ga_measurement_id: env.GA_MEASUREMENT_ID || null,
    });
  }
  if (u.pathname === "/api/chat") return chat(req, env);
  if (u.pathname === "/api/like") return likes(req, env);
  if (u.pathname === "/api/bible") {
    const bad = method(req, ["GET"]);
    if (bad) return bad;
    return station(env).fetch("https://station/bible");
  }
  if (u.pathname === "/api/status" || u.pathname === "/status.json") {
    const bad = method(req, ["GET"]);
    if (bad) return bad;
    return station(env).fetch("https://station/status");
  }
  if (u.pathname === "/live/playlist.m3u8") {
    const bad = method(req, ["GET"]);
    if (bad) return bad;
    return station(env).fetch("https://station/playlist");
  }
  if (u.pathname === "/live/meta.json") {
    const bad = method(req, ["GET"]);
    if (bad) return bad;
    return station(env).fetch("https://station/meta");
  }
  if (u.pathname === "/live/latest.json") {
    const bad = method(req, ["GET"]);
    if (bad) return bad;
    return station(env).fetch("https://station/latest");
  }
  if (/^\/live\/\d{6}\.ts$/.test(u.pathname)) {
    if (req.method !== "GET" && req.method !== "HEAD")
      return method(req, ["GET", "HEAD"])!;
    const filename = u.pathname.slice(6);
    if (filename === "000000.ts") {
      const assetUrl = new URL("/000000.ts", u);
      const asset = await env.ASSETS.fetch(
        new Request(assetUrl, { method: req.method }),
      );
      const h = new Headers(asset.headers);
      h.set("content-type", "video/mp2t");
      h.set("cache-control", "public,max-age=31536000,immutable");
      return new Response(req.method === "HEAD" ? null : asset.body, {
        status: asset.status,
        headers: h,
      });
    }
    const key = `segments/${filename}`;
    const o = await env.MEDIA.get(key);
    if (!o) return new Response("Not found", { status: 404 });
    const h = new Headers();
    o.writeHttpMetadata(h);
    h.set("etag", o.httpEtag);
    h.set("cache-control", "public,max-age=31536000,immutable");
    return new Response(req.method === "HEAD" ? null : o.body, { headers: h });
  }
  if (u.pathname === "/api/admin/policy") {
    if (!admin(req, env)) return json({ error: "unauthorized" }, 401);
    const bad = method(req, ["GET", "PUT"]);
    if (bad) return bad;
    if (req.method === "GET") return json(await policy(env));
    const p = (await body(req)) as Policy;
    const keys = [
      "nsfw",
      "copyrighted_characters",
      "brands",
      "public_figures",
      "graphic_violence",
      "non_graphic_violence",
    ];
    if (keys.some((k) => typeof (p as any)[k] !== "boolean"))
      return json({ error: "invalid_policy" }, 400);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('policy',?,?)",
    )
      .bind(JSON.stringify(p), Math.floor(Date.now() / 1000))
      .run();
    return json(p);
  }
  if (u.pathname === "/api/admin/generation") {
    if (!admin(req, env)) return json({ error: "unauthorized" }, 401);
    const bad = method(req, ["GET", "PUT"]);
    if (bad) return bad;
    if (req.method === "GET") {
      const saved = await env.DB.prepare(
        "SELECT value FROM settings WHERE key='generation_duration'",
      ).first("value");
      return json({ duration: generationDuration(saved ?? env.FAL_DURATION) });
    }
    const x = (await body(req)) as any;
    if (x.duration !== 5 && x.duration !== 10)
      return json({ error: "invalid_duration" }, 400);
    await env.DB.prepare(
      "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('generation_duration',?,?)",
    )
      .bind(String(x.duration), Math.floor(Date.now() / 1000))
      .run();
    return json({ duration: generationDuration(x.duration) });
  }
  if (u.pathname === "/api/admin/queue") {
    if (!admin(req, env)) return json({ error: "unauthorized" }, 401);
    const bad = method(req, ["GET"]);
    if (bad) return bad;
    const [messages, jobs] = await Promise.all([
      env.DB.prepare(
        "SELECT id,user,msg,status,rejection_code,job_id,created_at,seen_at,generating_at,ready_at,aired_at,failed_at FROM messages ORDER BY CASE WHEN status IN ('queued','seen','generating','ready') THEN 0 ELSE 1 END, CASE WHEN status IN ('queued','seen','generating','ready') THEN id END ASC, id DESC LIMIT 50",
      ).all(),
      env.DB.prepare(
        "SELECT id,fal_request_id,provider,status,expanded_prompt,created_at,started_at,ended_at,retry_count,error FROM generation_jobs ORDER BY created_at DESC LIMIT 30",
      ).all(),
    ]);
    return json({ messages: messages.results, jobs: jobs.results });
  }
  if (u.pathname === "/api/admin/clips") {
    if (!admin(req, env)) return json({ error: "unauthorized" }, 401);
    const bad = method(req, ["GET"]);
    if (bad) return bad;
    const clips = await env.DB.prepare(
      "SELECT id,segment_filename,chat_text,generated_at,duration,source,ready,first_aired_at,air_count FROM clips ORDER BY id DESC LIMIT 50",
    ).all();
    return json({ clips: clips.results });
  }
  const providerStatus = u.pathname.match(
    /^\/api\/admin\/jobs\/([A-Za-z0-9-]{8,80})\/provider-status$/,
  );
  if (providerStatus) {
    if (!admin(req, env)) return json({ error: "unauthorized" }, 401);
    const bad = method(req, ["GET"]);
    if (bad) return bad;
    const job = await env.DB.prepare(
      "SELECT id,fal_request_id,provider,status,expanded_prompt FROM generation_jobs WHERE id=?",
    )
      .bind(providerStatus[1])
      .first<{
        id: string;
        fal_request_id: string | null;
        provider: string;
        status: string;
        expanded_prompt: string;
      }>();
    if (!job) return json({ error: "job_not_found" }, 404);
    const provider = videoProvider(job.provider);
    if (
      !job.fal_request_id ||
      (provider === "fal" && !env.FAL_KEY) ||
      (provider === "wiro" && (!env.WIRO_API_KEY || !env.WIRO_API_SECRET))
    )
      return json({
        provider,
        job_status: job.status,
        provider_status: null,
      });
    let providerState = "UNKNOWN",
      queuePosition: number | null = null,
      providerHttpStatus = 200;
    try {
      if (provider === "wiro") {
        const task = await getWiroTaskDetail(job.fal_request_id, {
          apiKey: env.WIRO_API_KEY!,
          apiSecret: env.WIRO_API_SECRET!,
        });
        providerState = task.status;
      } else {
        const response = await fetch(
          falQueueRequestUrl(
            env.FAL_MODEL,
            job.fal_request_id,
            "/status?logs=0",
          ),
          { headers: { authorization: `Key ${env.FAL_KEY}` } },
        );
        providerHttpStatus = response.status;
        if (!response.ok)
          return json({
            provider,
            job_status: job.status,
            provider_status: "UNAVAILABLE",
            provider_http_status: response.status,
            queue_position: null,
          });
        const result = await response.json<any>();
        providerState = String(result.status || "UNKNOWN");
        queuePosition = Number.isFinite(result.queue_position)
          ? result.queue_position
          : null;
      }
    } catch (error) {
      const status = String(error).match(/wiro_http_(\d+)/)?.[1];
      return json({
        provider,
        job_status: job.status,
        provider_status: "UNAVAILABLE",
        provider_http_status: status ? Number(status) : null,
        queue_position: null,
      });
    }
    let resumed = false;
    const completed =
      provider === "wiro"
        ? wiroTaskState(providerState) === "completed"
        : providerState === "COMPLETED";
    if (completed && job.status === "submitted") {
      const rows = await env.DB.prepare(
        "SELECT id,user,msg,created_at FROM messages WHERE job_id=? ORDER BY id LIMIT 4",
      )
        .bind(job.id)
        .all<{ id: number; user: string; msg: string; created_at: number }>();
      if (rows.results.length) {
        await env.GENERATION_QUEUE.send({
          jobId: job.id,
          messageIds: rows.results.map((x) => x.id),
          selected: rows.results,
          prompt: job.expanded_prompt,
          chatText: rows.results.map((x) => `${x.user}: ${x.msg}`).join(" · "),
          phase: "poll",
          provider,
          falRequestId: job.fal_request_id,
          attempt: 0,
        } satisfies GenerationMessage);
        resumed = true;
        console.log(
          JSON.stringify({ event: "fal_job_resumed", job_id: job.id }),
        );
      }
    }
    return json({
      provider,
      job_status: job.status,
      provider_status: providerState,
      provider_http_status: providerHttpStatus,
      queue_position: queuePosition,
      resumed,
    });
  }
  const messageAction = u.pathname.match(
    /^\/api\/admin\/messages\/(\d+)\/action$/,
  );
  if (messageAction) {
    if (!admin(req, env)) return json({ error: "unauthorized" }, 401);
    const bad = method(req, ["POST"]);
    if (bad) return bad;
    const id = Number(messageAction[1]),
      input = (await body(req)) as { action?: string },
      action = String(input.action || "");
    const row = await env.DB.prepare(
      "SELECT id,status FROM messages WHERE id=?",
    )
      .bind(id)
      .first<{ id: number; status: string }>();
    if (!row) return json({ error: "message_not_found" }, 404);
    if (!adminMessageActionAllowed(row.status, action))
      return json({ error: "invalid_message_action", status: row.status }, 409);
    const now = Math.floor(Date.now() / 1000);
    if (action === "reject")
      await env.DB.prepare(
        "UPDATE messages SET status='rejected',rejection_code='operator_rejected',failed_at=? WHERE id=? AND status='queued'",
      )
        .bind(now, id)
        .run();
    else
      await env.DB.prepare(
        "UPDATE messages SET status='queued',rejection_code=NULL,job_id=NULL,seen_at=NULL,generating_at=NULL,ready_at=NULL,aired_at=NULL,failed_at=NULL WHERE id=? AND status IN ('failed','rejected')",
      )
        .bind(id)
        .run();
    console.log(JSON.stringify({ event: `message_${action}`, message_id: id }));
    return json({ id, status: action === "reject" ? "rejected" : "queued" });
  }
  const deleteMessage = u.pathname.match(/^\/api\/admin\/messages\/(\d+)$/);
  if (deleteMessage) {
    if (!admin(req, env)) return json({ error: "unauthorized" }, 401);
    const bad = method(req, ["DELETE"]);
    if (bad) return bad;
    const id = Number(deleteMessage[1]),
      row = await env.DB.prepare("SELECT id,job_id FROM messages WHERE id=?")
        .bind(id)
        .first<{ id: number; job_id: string | null }>();
    if (!row) return json({ error: "message_not_found" }, 404);
    const now = Math.floor(Date.now() / 1000);
    let cancelled = false;
    if (row.job_id) {
      const claim = await env.DB.prepare(
        "UPDATE generation_jobs SET status='failed',ended_at=?,error='operator_cancelled' WHERE id=? AND status NOT IN ('ready','failed') RETURNING id",
      )
        .bind(now, row.job_id)
        .first();
      cancelled = Boolean(claim);
      if (cancelled)
        await env.DB.prepare(
          "UPDATE messages SET status='failed',failed_at=? WHERE job_id=? AND status IN ('seen','generating')",
        )
          .bind(now, row.job_id)
          .run();
    }
    await env.DB.batch([
      env.DB.prepare("DELETE FROM clip_messages WHERE message_id=?").bind(id),
      env.DB.prepare("DELETE FROM messages WHERE id=?").bind(id),
    ]);
    if (cancelled)
      await station(env).fetch("https://station/job", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ error: "operator_cancelled" }),
      });
    console.log(
      JSON.stringify({
        event: "message_deleted",
        message_id: id,
        job_cancelled: cancelled,
      }),
    );
    return json({ deleted: true, id, job_cancelled: cancelled });
  }
  const clipAction = u.pathname.match(/^\/api\/admin\/clips\/(\d+)\/action$/);
  if (clipAction) {
    if (!admin(req, env)) return json({ error: "unauthorized" }, 401);
    const bad = method(req, ["POST"]);
    if (bad) return bad;
    const id = Number(clipAction[1]),
      input = (await body(req)) as { action?: string },
      action = String(input.action || "");
    const clip = await env.DB.prepare(
      "SELECT id,ready,segment_filename,r2_key,generation_job_id FROM clips WHERE id=?",
    )
      .bind(id)
      .first<{
        id: number;
        ready: number;
        segment_filename: string | null;
        r2_key: string | null;
        generation_job_id: string | null;
      }>();
    if (!clip) return json({ error: "clip_not_found" }, 404);
    if (
      action === "repair" &&
      !clip.segment_filename &&
      clip.generation_job_id
    ) {
      const job = await env.DB.prepare(
        "SELECT id,fal_request_id,expanded_prompt,provider FROM generation_jobs WHERE id=?",
      )
        .bind(clip.generation_job_id)
        .first<{
          id: string;
          fal_request_id: string | null;
          expanded_prompt: string;
          provider: "fal" | "wiro";
        }>();
      if (!job?.fal_request_id)
        return json({ error: "clip_not_repairable" }, 409);
      const rows = await env.DB.prepare(
        "SELECT id,user,msg,created_at FROM messages WHERE job_id=? ORDER BY id LIMIT 4",
      )
        .bind(job.id)
        .all<{ id: number; user: string; msg: string; created_at: number }>();
      if (!rows.results.length)
        return json({ error: "clip_not_repairable" }, 409);
      await station(env).fetch("https://station/remove-clip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clipId: id }),
      });
      const now = Math.floor(Date.now() / 1000);
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE clips SET ready=0,first_aired_at=NULL WHERE id=?",
        ).bind(id),
        env.DB.prepare(
          "UPDATE generation_jobs SET status='submitted',started_at=?,ended_at=NULL,error=NULL WHERE id=?",
        ).bind(now, job.id),
        env.DB.prepare(
          "UPDATE messages SET status='generating',ready_at=NULL,aired_at=NULL,failed_at=NULL WHERE job_id=?",
        ).bind(job.id),
      ]);
      await env.GENERATION_QUEUE.send({
        jobId: job.id,
        messageIds: rows.results.map((x) => x.id),
        selected: rows.results,
        prompt: job.expanded_prompt,
        chatText: rows.results.map((x) => `${x.user}: ${x.msg}`).join(" · "),
        phase: "poll",
        provider: videoProvider(job.provider),
        falRequestId: job.fal_request_id,
        attempt: 0,
      } satisfies GenerationMessage);
      console.log(
        JSON.stringify({
          event: "clip_repair_queued",
          clip_id: id,
          job_id: job.id,
        }),
      );
      return json({ id, ready: 0, repair_queued: true });
    }
    if (!adminClipActionAllowed(clip.ready, action))
      return json({ error: "invalid_clip_action", ready: clip.ready }, 409);
    if (
      action === "enable" &&
      (!clip.segment_filename ||
        !clip.r2_key ||
        !(await env.MEDIA.head(clip.r2_key)))
    )
      return json({ error: "clip_not_packaged" }, 409);
    if (action === "disable")
      await station(env).fetch("https://station/remove-clip", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ clipId: id }),
      });
    await env.DB.prepare("UPDATE clips SET ready=? WHERE id=?")
      .bind(action === "enable" ? 1 : 0, id)
      .run();
    console.log(JSON.stringify({ event: `clip_${action}d`, clip_id: id }));
    return json({ id, ready: action === "enable" ? 1 : 0 });
  }
  const deleteClip = u.pathname.match(/^\/api\/admin\/clips\/(\d+)$/);
  if (deleteClip) {
    if (!admin(req, env)) return json({ error: "unauthorized" }, 401);
    const bad = method(req, ["DELETE"]);
    if (bad) return bad;
    const id = Number(deleteClip[1]),
      clip = await env.DB.prepare("SELECT id,r2_key FROM clips WHERE id=?")
        .bind(id)
        .first<{ id: number; r2_key: string | null }>();
    if (!clip) return json({ error: "clip_not_found" }, 404);
    await station(env).fetch("https://station/remove-clip", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clipId: id }),
    });
    await ensureRepeatLikes(env);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM likes WHERE clip_id=?").bind(id),
      env.DB.prepare("DELETE FROM like_events WHERE clip_id=?").bind(id),
      env.DB.prepare("DELETE FROM clip_messages WHERE clip_id=?").bind(id),
      env.DB.prepare("DELETE FROM clips WHERE id=?").bind(id),
    ]);
    if (clip.r2_key) await env.MEDIA.delete(clip.r2_key);
    console.log(JSON.stringify({ event: "clip_deleted", clip_id: id }));
    return json({ deleted: true, id });
  }
  if (u.pathname === "/api/admin/integrations") {
    if (!admin(req, env)) return json({ error: "unauthorized" }, 401);
    const bad = method(req, ["GET"]);
    if (bad) return bad;
    let stripe = "disabled";
    try {
      assertTestStripe(env);
      if (env.STRIPE_ENABLED === "true")
        stripe =
          env.STRIPE_SECRET_KEY &&
          env.STRIPE_PRICE_ID &&
          env.STRIPE_WEBHOOK_SECRET
            ? "sandbox_ready"
            : "incomplete";
    } catch {
      stripe = "live_key_rejected";
    }
    return json({
      video_provider: videoProvider(env.VIDEO_PROVIDER),
      fal: env.FAL_KEY ? "configured" : "missing_key",
      wiro:
        env.WIRO_API_KEY && env.WIRO_API_SECRET
          ? "configured"
          : "missing_credentials",
      media_packager:
        env.MEDIA_PACKAGER && env.PACKAGER_TOKEN
          ? "configured"
          : "container_unavailable",
      turnstile:
        env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY
          ? "configured"
          : "incomplete",
      director:
        env.DIRECTOR_PROVIDER === "deterministic"
          ? "deterministic"
          : env.DIRECTOR_API_KEY && env.DIRECTOR_BASE_URL && env.DIRECTOR_MODEL
            ? "configured"
            : "fallback",
      stripe,
    });
  }
  if (u.pathname === "/api/admin/pause" || u.pathname === "/api/admin/resume") {
    if (!admin(req, env)) return json({ error: "unauthorized" }, 401);
    const bad = method(req, ["POST"]);
    if (bad) return bad;
    return station(env).fetch(
      `https://station/${u.pathname.endsWith("pause") ? "pause" : "resume"}`,
      { method: "POST" },
    );
  }
  if (u.pathname === "/api/billing/checkout") {
    const bad = method(req, ["POST"]);
    if (bad) return bad;
    return checkout(env, u.origin);
  }
  if (u.pathname === "/api/billing/webhook") {
    const bad = method(req, ["POST"]);
    if (bad) return bad;
    return webhook(req, env);
  }
  if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/live/"))
    return json({ error: "not_found" }, 404);
  return env.ASSETS.fetch(req);
}
async function processGeneration(msg: Message<GenerationMessage>, env: Env) {
  const x = msg.body;
  const job = await env.DB.prepare(
    "SELECT status,fal_request_id,retry_count,started_at,provider FROM generation_jobs WHERE id=?",
  )
    .bind(x.jobId)
    .first<any>();
  if (!job || job.status === "ready") {
    msg.ack();
    return;
  }
  const existing = await env.DB.prepare(
    "SELECT id,ready FROM clips WHERE generation_job_id=?",
  )
    .bind(x.jobId)
    .first<any>();
  if (existing?.ready) {
    const now = Math.floor(Date.now() / 1000);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE generation_jobs SET status='ready',ended_at=?,error=NULL WHERE id=?",
      ).bind(now, x.jobId),
      env.DB.prepare(
        "UPDATE messages SET status='ready',ready_at=? WHERE job_id=? AND status='generating'",
      ).bind(now, x.jobId),
    ]);
    await station(env).fetch("https://station/job", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ generation: existing.id, selected: x.selected }),
    });
    msg.ack();
    return;
  }
  if (job.status === "failed") {
    msg.ack();
    return;
  }
  const jobNow = Math.floor(Date.now() / 1000);
  if (
    job.status === "packaging" &&
    !packagingClaimable(job.status, job.started_at, jobNow)
  ) {
    await env.GENERATION_QUEUE.send(x, { delaySeconds: 30 });
    msg.ack();
    return;
  }
  const provider = videoProvider(
    job.provider || x.provider || env.VIDEO_PROVIDER,
  );
  x.provider = provider;
  if (provider === "wiro") {
    await processWiroGeneration(msg, env, x, job);
    return;
  }
  if (!env.FAL_KEY) {
    await failJob(env, x, "fal_not_configured");
    msg.ack();
    return;
  }
  assertTestStripe(env);
  if (!x.falRequestId && job.fal_request_id)
    x.falRequestId = job.fal_request_id;
  if (!x.falRequestId) {
    const now = Math.floor(Date.now() / 1000);
    if (job.status === "submitting" && Number(job.started_at) > now - 120) {
      await env.GENERATION_QUEUE.send(x, { delaySeconds: 15 });
      msg.ack();
      return;
    }
    const claim = await env.DB.prepare(
      "UPDATE generation_jobs SET status='submitting',started_at=? WHERE id=? AND (status='created' OR (status='submitting' AND started_at<?)) RETURNING id",
    )
      .bind(now, x.jobId, now - 120)
      .first();
    if (!claim) {
      await env.GENERATION_QUEUE.send(x, { delaySeconds: 15 });
      msg.ack();
      return;
    }
    const duration = promptDuration(x.prompt, env.FAL_DURATION);
    const r = await fetch(`https://queue.fal.run/${env.FAL_MODEL}`, {
      method: "POST",
      headers: {
        authorization: `Key ${env.FAL_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        prompt: x.prompt,
        duration,
        resolution: env.FAL_RESOLUTION,
        aspect_ratio: env.FAL_ASPECT_RATIO,
        prompt_expansion_mode: env.FAL_PROMPT_EXPANSION,
        enable_safety_checker: true,
      }),
    });
    if (!r.ok) {
      await failJob(env, x, "fal_submit_failed");
      msg.retry();
      return;
    }
    const j = await r.json<{ request_id: string }>();
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE generation_jobs SET status='submitted',fal_request_id=?,started_at=? WHERE id=? AND fal_request_id IS NULL",
      ).bind(j.request_id, now, x.jobId),
      env.DB.prepare(
        `UPDATE messages SET status='generating',generating_at=? WHERE job_id=? AND status='seen'`,
      ).bind(now, x.jobId),
    ]);
    await env.GENERATION_QUEUE.send(
      { ...x, phase: "poll", falRequestId: j.request_id, attempt: 0 },
      { delaySeconds: 15 },
    );
    console.log(
      JSON.stringify({
        event: "fal_submitted",
        job_id: x.jobId,
        request_id: j.request_id,
        duration,
      }),
    );
    msg.ack();
    return;
  }
  const sr = await fetch(
    falQueueRequestUrl(env.FAL_MODEL, x.falRequestId, "/status?logs=0"),
    { headers: { authorization: `Key ${env.FAL_KEY}` } },
  );
  if (!sr.ok) {
    if ([401, 403, 404].includes(sr.status)) {
      await failJob(env, x, `fal_status_${sr.status}`);
      msg.ack();
      return;
    }
    if ((x.attempt || 0) > 80) {
      await failJob(env, x, "fal_status_unavailable");
      msg.ack();
      return;
    }
    await env.GENERATION_QUEUE.send(
      { ...x, attempt: (x.attempt || 0) + 1 },
      { delaySeconds: 15 },
    );
    msg.ack();
    return;
  }
  const sj = await sr.json<any>();
  if (sj.status !== "COMPLETED") {
    if (sj.status === "FAILED" || (x.attempt || 0) > 80) {
      await failJob(env, x, "fal_generation_failed");
      msg.ack();
      return;
    }
    await env.DB.prepare(
      "UPDATE generation_jobs SET started_at=? WHERE id=? AND status='submitted'",
    )
      .bind(Math.floor(Date.now() / 1000), x.jobId)
      .run();
    await env.GENERATION_QUEUE.send(
      { ...x, attempt: (x.attempt || 0) + 1 },
      { delaySeconds: 15 },
    );
    msg.ack();
    return;
  }
  if (
    await env.DB.prepare(
      "SELECT 1 FROM generation_jobs WHERE id=? AND status='failed'",
    )
      .bind(x.jobId)
      .first()
  ) {
    msg.ack();
    return;
  }
  const rr = await fetch(falQueueRequestUrl(env.FAL_MODEL, x.falRequestId), {
    headers: { authorization: `Key ${env.FAL_KEY}` },
  });
  if (!rr.ok) {
    await failJob(env, x, "fal_result_unavailable");
    msg.ack();
    return;
  }
  const result = await rr.json<any>();
  const url = String(result.video?.url || "");
  if (!url) {
    await failJob(env, x, "fal_result_missing_video");
    msg.ack();
    return;
  }
  const sourceDuration = sourceVideoDuration(
    result.video?.duration,
    x.prompt,
    env.FAL_DURATION,
  );
  await completeGenerationSource(msg, env, x, job, url, sourceDuration);
}
async function processWiroGeneration(
  msg: Message<GenerationMessage>,
  env: Env,
  x: GenerationMessage,
  job: any,
) {
  if (!env.WIRO_API_KEY || !env.WIRO_API_SECRET) {
    await failJob(env, x, "wiro_not_configured");
    msg.ack();
    return;
  }
  assertTestStripe(env);
  if (!x.falRequestId && job.fal_request_id)
    x.falRequestId = job.fal_request_id;
  const credentials = {
    apiKey: env.WIRO_API_KEY,
    apiSecret: env.WIRO_API_SECRET,
  };
  if (!x.falRequestId) {
    const now = Math.floor(Date.now() / 1000);
    if (job.status === "submitting" && Number(job.started_at) > now - 120) {
      await env.GENERATION_QUEUE.send(x, { delaySeconds: 15 });
      msg.ack();
      return;
    }
    const claim = await env.DB.prepare(
      "UPDATE generation_jobs SET status='submitting',started_at=? WHERE id=? AND (status='created' OR (status='submitting' AND started_at<?)) RETURNING id",
    )
      .bind(now, x.jobId, now - 120)
      .first();
    if (!claim) {
      await env.GENERATION_QUEUE.send(x, { delaySeconds: 15 });
      msg.ack();
      return;
    }
    const duration = providerGenerationDuration("wiro", env.FAL_DURATION);
    let submission;
    try {
      submission = await submitWiroTask(
        wiroRunInput(
          x.prompt,
          duration,
          env.WIRO_RESOLUTION,
          env.WIRO_RATIO,
          env.WIRO_SEED,
        ),
        credentials,
      );
    } catch {
      await failJob(env, x, "wiro_submit_failed");
      msg.ack();
      return;
    }
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE generation_jobs SET status='submitted',fal_request_id=?,started_at=? WHERE id=? AND fal_request_id IS NULL",
      ).bind(submission.taskid, now, x.jobId),
      env.DB.prepare(
        "UPDATE messages SET status='generating',generating_at=? WHERE job_id=? AND status='seen'",
      ).bind(now, x.jobId),
    ]);
    await env.GENERATION_QUEUE.send(
      {
        ...x,
        phase: "poll",
        provider: "wiro",
        falRequestId: submission.taskid,
        attempt: 0,
      },
      { delaySeconds: 15 },
    );
    console.log(
      JSON.stringify({
        event: "wiro_submitted",
        job_id: x.jobId,
        task_id: submission.taskid,
        duration,
      }),
    );
    msg.ack();
    return;
  }
  let task;
  try {
    task = await getWiroTaskDetail(x.falRequestId, credentials);
  } catch {
    if ((x.attempt || 0) > 80) {
      await failJob(env, x, "wiro_status_unavailable");
      msg.ack();
      return;
    }
    await env.GENERATION_QUEUE.send(
      { ...x, attempt: (x.attempt || 0) + 1 },
      { delaySeconds: 15 },
    );
    msg.ack();
    return;
  }
  let state;
  try {
    state = wiroTaskState(task.status);
  } catch {
    await failJob(env, x, "wiro_unknown_status");
    msg.ack();
    return;
  }
  if (state === "cancelled") {
    await failJob(env, x, "wiro_task_cancelled");
    msg.ack();
    return;
  }
  if (state === "running") {
    if ((x.attempt || 0) > 80) {
      await failJob(env, x, "wiro_poll_timeout");
      msg.ack();
      return;
    }
    await env.DB.prepare(
      "UPDATE generation_jobs SET started_at=? WHERE id=? AND status='submitted'",
    )
      .bind(Math.floor(Date.now() / 1000), x.jobId)
      .run();
    await env.GENERATION_QUEUE.send(
      { ...x, attempt: (x.attempt || 0) + 1 },
      { delaySeconds: 15 },
    );
    msg.ack();
    return;
  }
  if (
    await env.DB.prepare(
      "SELECT 1 FROM generation_jobs WHERE id=? AND status='failed'",
    )
      .bind(x.jobId)
      .first()
  ) {
    msg.ack();
    return;
  }
  let url: string;
  try {
    url = wiroVideoOutput(task).url;
  } catch {
    await failJob(env, x, "wiro_result_missing_video");
    msg.ack();
    return;
  }
  await completeGenerationSource(
    msg,
    env,
    x,
    job,
    url,
    providerGenerationDuration("wiro", env.FAL_DURATION),
  );
}
async function completeGenerationSource(
  msg: Message<GenerationMessage>,
  env: Env,
  x: GenerationMessage,
  job: any,
  url: string,
  sourceDuration: number,
) {
  const sourceAt = Math.floor(Date.now() / 1000);
  await env.DB.prepare(
    "INSERT OR IGNORE INTO clips(generation_job_id,prompt,chat_text,generated_at,duration,source,ready) VALUES(?,?,?,?,?,'generated',0)",
  )
    .bind(x.jobId, x.prompt, x.chatText, sourceAt, sourceDuration)
    .run();
  const clip = await env.DB.prepare(
    "SELECT id,ready,first_aired_at FROM clips WHERE generation_job_id=?",
  )
    .bind(x.jobId)
    .first<any>();
  if (!clip) throw new Error("clip_reservation_failed");
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?,?,?)",
    ).bind(`clip_source:${clip.id}`, url, sourceAt),
    env.DB.prepare(
      "UPDATE generation_jobs SET status='source_ready',started_at=?,error=NULL WHERE id=? AND status!='ready'",
    ).bind(sourceAt, x.jobId),
    env.DB.prepare(
      "UPDATE messages SET status='ready',ready_at=COALESCE(ready_at,?) WHERE job_id=? AND status='generating'",
    ).bind(sourceAt, x.jobId),
    ...x.messageIds.map((id) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO clip_messages(clip_id,message_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM messages WHERE id=?)",
      ).bind(clip.id, id, id),
    ),
  ]);
  if (!clip.first_aired_at)
    await station(env).fetch("https://station/job", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        generation: clip.id,
        selected: x.selected,
        sourceUrl: url,
        duration: sourceDuration,
        chatText: x.chatText,
      }),
    });
  if (!env.MEDIA_PACKAGER || !env.PACKAGER_TOKEN) {
    console.warn(
      JSON.stringify({
        event: "archive_skipped",
        job_id: x.jobId,
        error: "media_packager_unavailable",
      }),
    );
    msg.ack();
    return;
  }
  const packagingAt = Math.floor(Date.now() / 1000);
  const claim = await env.DB.prepare(
    "UPDATE generation_jobs SET status='packaging',started_at=? WHERE id=? AND status='source_ready' AND NOT EXISTS (SELECT 1 FROM generation_jobs WHERE status='packaging' AND id!=?) RETURNING id",
  )
    .bind(packagingAt, x.jobId, x.jobId)
    .first();
  if (!claim) {
    await env.GENERATION_QUEUE.send(x, { delaySeconds: 20 });
    msg.ack();
    return;
  }
  const pr = await env.MEDIA_PACKAGER.getByName("packager").fetch(
    "https://packager/package",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${env.PACKAGER_TOKEN}`,
      },
      body: JSON.stringify({ source_url: url, generation_id: x.jobId }),
    },
  );
  if (!pr.ok) {
    if (Number(job.retry_count || 0) < 2) {
      await env.DB.prepare(
        "UPDATE generation_jobs SET status='source_ready',started_at=?,retry_count=retry_count+1,error='media_packaging_failed' WHERE id=? AND status='packaging'",
      )
        .bind(Math.floor(Date.now() / 1000), x.jobId)
        .run();
      await env.GENERATION_QUEUE.send(x, { delaySeconds: 30 });
      msg.ack();
      return;
    }
    await env.DB.prepare(
      "UPDATE generation_jobs SET status='ready',ended_at=?,error='media_archive_failed' WHERE id=?",
    )
      .bind(Math.floor(Date.now() / 1000), x.jobId)
      .run();
    msg.ack();
    return;
  }
  const duration = Number(pr.headers.get("x-media-duration") || sourceDuration),
    filename = `${String(clip.id).padStart(6, "0")}.ts`,
    key = `segments/${filename}`;
  if (!(await env.MEDIA.head(key)))
    await env.MEDIA.put(key, pr.body, {
      httpMetadata: {
        contentType: "video/mp2t",
        cacheControl: "public,max-age=31536000,immutable",
      },
    });
  const finishedAt = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE clips SET segment_filename=?,r2_key=?,duration=?,ready=1 WHERE id=?",
    ).bind(filename, key, duration, clip.id),
    env.DB.prepare(
      "UPDATE generation_jobs SET status='ready',ended_at=?,error=NULL WHERE id=?",
    ).bind(finishedAt, x.jobId),
  ]);
  console.log(
    JSON.stringify({
      event: "clip_archived",
      clip_id: clip.id,
      job_id: x.jobId,
    }),
  );
  msg.ack();
}
async function failJob(env: Env, x: GenerationMessage, error: string) {
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE generation_jobs SET status='failed',ended_at=?,error=? WHERE id=? AND status!='ready'",
    ).bind(now, error, x.jobId),
    env.DB.prepare(
      "UPDATE messages SET status='failed',failed_at=? WHERE job_id=? AND status IN ('seen','generating')",
    ).bind(now, x.jobId),
  ]);
  await station(env).fetch("https://station/job", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ error }),
  });
  console.error(
    JSON.stringify({ event: "generation_failed", job_id: x.jobId, error }),
  );
}
export default {
  async fetch(req: Request, env: Env) {
    try {
      return finalize(req, await handle(req, env));
    } catch (e) {
      if (e instanceof Response) return finalize(req, e);
      console.error(
        JSON.stringify({
          event: "request_error",
          error: String(e).slice(0, 200),
        }),
      );
      return finalize(req, json({ error: "internal_error" }, 500));
    }
  },
  async queue(batch: MessageBatch<GenerationMessage>, env: Env) {
    for (const m of batch.messages) await processGeneration(m, env);
  },
} satisfies ExportedHandler<Env, GenerationMessage>;
