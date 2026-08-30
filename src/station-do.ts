import { DurableObject } from "cloudflare:workers";
import {
  boundedRateHit,
  expireBible,
  knownLikeTarget,
  playlist,
  providerGenerationDuration,
  publicAttribution,
  reconstructPlaylistWindow,
  stationCadenceMs,
  updateBible,
  videoProvider,
  type Bible,
  type ChatCandidate,
} from "./core";
import { direct } from "./director";
import type { Env, GenerationMessage } from "./types";
type Entry = {
  sequence: number;
  clipId: number;
  filename: string | null;
  mediaUrl?: string;
  duration: number;
  replay: boolean;
  chatText: string;
  generatedAt: number;
};
type State = {
  mediaSequence: number;
  window: Entry[];
  recentClipIds?: number[];
  paused: boolean;
  inFlight: number;
  lastError: string | null;
  bible: Bible;
  viewers: Record<string, number>;
  rateBuckets?: Record<string, number[]>;
};
const initial: State = {
  mediaSequence: 1,
  window: [],
  recentClipIds: [],
  paused: false,
  inFlight: 0,
  lastError: null,
  bible: {
    props: [],
    last_form: null,
    previous_setting: null,
    previous_owner: null,
    note: "",
  },
  viewers: {},
  rateBuckets: {},
};
const bootstrapEntry = (sequence: number, now: number): Entry => ({
  sequence,
  clipId: 0,
  filename: "000000.ts",
  duration: 5,
  replay: true,
  chatText: "station: signal warming up",
  generatedAt: now,
});
export class Station extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      if (!(await ctx.storage.get("state")))
        await ctx.storage.put("state", initial);
      if (!(await ctx.storage.getAlarm()))
        await ctx.storage.setAlarm(Date.now() + 1000);
    });
  }
  private async state() {
    return (
      (await this.ctx.storage.get<State>("state")) || structuredClone(initial)
    );
  }
  private async save(s: State) {
    await this.ctx.storage.put("state", s);
  }
  async alarm() {
    try {
      await this.tick();
    } catch (e) {
      const s = await this.state();
      s.lastError = String(e).slice(0, 160);
      await this.save(s);
      console.error(
        JSON.stringify({ event: "alarm_failure", error: s.lastError }),
      );
    } finally {
      const s = await this.state();
      await this.ctx.storage.setAlarm(
        Date.now() +
          stationCadenceMs(s.window.at(-1)?.duration || this.env.FAL_DURATION),
      );
    }
  }
  async tick() {
    const s = await this.state();
    const now = Math.floor(Date.now() / 1000);
    s.viewers = Object.fromEntries(
      Object.entries(s.viewers).filter(([, t]) => now - t < 45),
    );
    await this.env.DB.prepare(
      "UPDATE messages SET status='aired',aired_at=COALESCE(aired_at,(SELECT first_aired_at FROM clips WHERE clips.generation_job_id=messages.job_id)) WHERE status='ready' AND EXISTS (SELECT 1 FROM clips WHERE clips.generation_job_id=messages.job_id AND clips.first_aired_at IS NOT NULL)",
    ).run();
    if (s.bible.props.length === 0) {
      const persisted = await this.env.DB.prepare(
        "SELECT value FROM settings WHERE key='bible'",
      ).first<string>("value");
      if (persisted) {
        try {
          s.bible = JSON.parse(persisted) as Bible;
        } catch {
          console.error(JSON.stringify({ event: "bible_hydration_failed" }));
        }
      }
    }
    if (!s.window.length) {
      const history = await this.env.DB.prepare(
        "SELECT id,segment_filename,duration,chat_text,generated_at FROM clips WHERE ready=1 AND segment_filename IS NOT NULL AND r2_key IS NOT NULL ORDER BY COALESCE(first_aired_at,generated_at) DESC,id DESC LIMIT 6",
      ).all<any>();
      const restored = reconstructPlaylistWindow(
        history.results,
        s.mediaSequence,
      );
      s.mediaSequence = restored.mediaSequence;
      s.window = restored.window;
      s.recentClipIds = s.window
        .map((x) => x.clipId)
        .filter(Boolean)
        .slice(-12);
      if (history.results.length)
        console.log(
          JSON.stringify({
            event: "station_state_reconstructed",
            clips: history.results.length,
          }),
        );
    }
    const ready = await this.env.DB.prepare(
      "SELECT id,segment_filename,duration,chat_text,generated_at FROM clips WHERE ready=1 AND segment_filename IS NOT NULL AND r2_key IS NOT NULL AND first_aired_at IS NULL ORDER BY id LIMIT 6",
    ).all<any>();
    let inserted = 0;
    if (ready.results.length) {
      for (const c of ready.results) {
        if (s.window.some((x) => x.clipId === c.id && !x.replay)) continue;
        s.mediaSequence++;
        inserted++;
        s.window.push({
          sequence: s.mediaSequence,
          clipId: c.id,
          filename: c.segment_filename,
          duration: c.duration,
          replay: false,
          chatText: c.chat_text,
          generatedAt: c.generated_at,
        });
        s.window = s.window.slice(-6);
        s.recentClipIds = [...(s.recentClipIds || []), c.id].slice(-12);
        await this.env.DB.batch([
          this.env.DB.prepare(
            "UPDATE clips SET first_aired_at=COALESCE(first_aired_at,?),air_count=air_count+1 WHERE id=?",
          ).bind(now, c.id),
          this.env.DB.prepare(
            "UPDATE messages SET status='aired',aired_at=? WHERE id IN (SELECT message_id FROM clip_messages WHERE clip_id=?) AND status='ready'",
          ).bind(now, c.id),
        ]);
        console.log(JSON.stringify({ event: "clip_aired", clip_id: c.id }));
      }
    }
    if (inserted === 0 && s.window.length) {
      const playable =
        "((c.ready=1 AND c.segment_filename IS NOT NULL AND c.r2_key IS NOT NULL) OR src.value IS NOT NULL)";
      const previous = s.window.at(-1)?.clipId || 0;
      let old = await this.env.DB.prepare(
        `SELECT c.id,c.segment_filename,c.duration,c.chat_text,c.generated_at,src.value media_url FROM clips c LEFT JOIN settings src ON src.key='clip_source:'||c.id WHERE ${playable} AND c.id>? ORDER BY c.id ASC LIMIT 1`,
      )
        .bind(previous)
        .first<any>();
      if (!old) {
        const liveTail = await this.env.DB.prepare(
          `SELECT c.id,c.segment_filename,c.duration,c.chat_text,c.generated_at,src.value media_url FROM clips c LEFT JOIN settings src ON src.key='clip_source:'||c.id WHERE ${playable} ORDER BY c.generated_at DESC,c.id DESC LIMIT 3`,
        ).all<any>();
        old = liveTail.results.at(-1) || null;
      }
      if (old) {
        s.mediaSequence++;
        s.window.push({
          sequence: s.mediaSequence,
          clipId: old.id,
          filename: old.segment_filename || null,
          mediaUrl: old.segment_filename ? undefined : old.media_url,
          duration: old.duration,
          replay: true,
          chatText: old.chat_text,
          generatedAt: old.generated_at,
        });
        s.window = s.window.slice(-6);
        s.recentClipIds = [...(s.recentClipIds || []), old.id].slice(-12);
        await this.env.DB.prepare(
          "UPDATE clips SET air_count=air_count+1 WHERE id=?",
        )
          .bind(old.id)
          .run();
        console.log(
          JSON.stringify({
            event: "rerun_insert",
            clip_id: old.id,
            source: old.segment_filename ? "r2" : "fal",
          }),
        );
      }
    }
    if (!s.window.length) {
      s.mediaSequence++;
      s.window = [bootstrapEntry(s.mediaSequence, now)];
      console.log(JSON.stringify({ event: "bootstrap_insert" }));
    }
    const stale = await this.env.DB.prepare(
      "SELECT id,status,fal_request_id,expanded_prompt,provider FROM generation_jobs WHERE (status IN ('submitted','source_ready') AND started_at<?) OR (status='packaging' AND started_at<?) ORDER BY created_at LIMIT 2",
    )
      .bind(now - 90, now - 600)
      .all<{
        id: string;
        status: string;
        fal_request_id: string | null;
        expanded_prompt: string;
        provider: "fal" | "wiro";
      }>();
    for (const job of stale.results) {
      const claimed = await this.env.DB.prepare(
        "UPDATE generation_jobs SET status=?,started_at=?,retry_count=retry_count+1 WHERE id=? AND status=? RETURNING id",
      )
        .bind(
          job.status === "source_ready" ? "source_ready" : "submitted",
          now,
          job.id,
          job.status,
        )
        .first();
      if (!claimed) continue;
      const rows = await this.env.DB.prepare(
        "SELECT id,user,msg,created_at FROM messages WHERE job_id=? ORDER BY id LIMIT 4",
      )
        .bind(job.id)
        .all<ChatCandidate>();
      if (!rows.results.length) continue;
      await this.env.GENERATION_QUEUE.send({
        jobId: job.id,
        messageIds: rows.results.map((x) => x.id),
        selected: rows.results,
        prompt: job.expanded_prompt,
        chatText: rows.results.map((x) => `${x.user}: ${x.msg}`).join(" · "),
        phase: "poll",
        provider: videoProvider(job.provider),
        falRequestId: job.fal_request_id || undefined,
        attempt: 0,
      } satisfies GenerationMessage);
      console.log(
        JSON.stringify({
          event: "stale_job_requeued",
          job_id: job.id,
          previous_status: job.status,
        }),
      );
    }
    s.inFlight = Number(
      (await this.env.DB.prepare(
        "SELECT COUNT(*) n FROM generation_jobs WHERE status IN ('created','submitting','submitted')",
      ).first("n")) || 0,
    );
    if (!s.paused && s.inFlight < 2) {
      const rows = await this.env.DB.prepare(
        "SELECT id,user,msg,created_at FROM messages WHERE status='queued' ORDER BY id LIMIT 20",
      ).all<ChatCandidate>();
      const provider = videoProvider(this.env.VIDEO_PROVIDER);
      const configuredDuration = await this.env.DB.prepare(
        "SELECT value FROM settings WHERE key='generation_duration'",
      ).first("value");
      const duration = providerGenerationDuration(provider, configuredDuration);
      const decision = await direct(rows.results, s.bible, this.env, duration);
      if (decision.selected.length) {
        const ids = decision.selected.map((x) => x.id);
        const jobId = crypto.randomUUID();
        await this.env.DB.batch([
          this.env.DB.prepare(
            `UPDATE messages SET status='seen',seen_at=?,job_id=? WHERE id IN (${ids.map(() => "?").join(",")}) AND status='queued'`,
          ).bind(now, jobId, ...ids),
          this.env.DB.prepare(
            "INSERT INTO generation_jobs(id,status,expanded_prompt,created_at,provider) VALUES(?,?,?,?,?)",
          ).bind(jobId, "created", decision.expandedPrompt, now, provider),
        ]);
        await this.env.GENERATION_QUEUE.send({
          jobId,
          messageIds: ids,
          selected: decision.selected,
          prompt: decision.expandedPrompt,
          chatText: decision.chatText,
          provider,
        } satisfies GenerationMessage);
        s.inFlight++;
        console.log(
          JSON.stringify({
            event: "messages_selected",
            job_id: jobId,
            message_ids: ids,
            duration,
          }),
        );
      }
    }
    s.bible = expireBible(
      s.bible,
      Number(
        (await this.env.DB.prepare(
          "SELECT COUNT(*) n FROM clips WHERE ready=1 AND source='generated'",
        ).first("n")) || 0,
      ),
    );
    await this.save(s);
  }
  async fetch(req: Request) {
    const u = new URL(req.url);
    const s = await this.state();
    const viewer = req.headers.get("x-viewer-id");
    if (viewer) {
      s.viewers[viewer] = Math.floor(Date.now() / 1000);
      await this.save(s);
    }
    if (u.pathname === "/rate") {
      const key = `rl:${u.searchParams.get("key") || "anon"}`;
      const limit = Math.max(
        1,
        Math.min(60, Number(u.searchParams.get("limit")) || 5),
      );
      const windowMs = Math.max(
        1_000,
        Math.min(300_000, Number(u.searchParams.get("window")) || 30_000),
      );
      const result = boundedRateHit(
        s.rateBuckets || {},
        key,
        Date.now(),
        limit,
        2_000,
        windowMs,
      );
      s.rateBuckets = result.buckets;
      await this.save(s);
      if (!result.allowed) return new Response("rate limited", { status: 429 });
      return new Response("ok");
    }
    if (u.pathname === "/playlist") {
      const archived = s.window.filter((x): x is Entry & { filename: string } =>
        Boolean(x.filename),
      );
      return new Response(
        playlist(archived, archived[0]?.sequence || s.mediaSequence),
        {
          headers: {
            "content-type": "application/vnd.apple.mpegurl",
            "cache-control": "no-store",
          },
        },
      );
    }
    if (u.pathname === "/meta")
      return Response.json(
        {
          sequence: s.mediaSequence,
          clips: s.window.map((x) => ({
            ...x,
            chatText: publicAttribution(x.chatText),
          })),
        },
        { headers: { "cache-control": "no-store" } },
      );
    if (u.pathname === "/latest") {
      const playable =
        "((c.ready=1 AND c.segment_filename IS NOT NULL AND c.r2_key IS NOT NULL) OR src.value IS NOT NULL)";
      const latest = await this.env.DB.prepare(
        `SELECT c.id,c.segment_filename,c.duration,c.chat_text,c.generated_at,c.first_aired_at,src.value media_url FROM clips c LEFT JOIN settings src ON src.key='clip_source:'||c.id WHERE ${playable} ORDER BY c.generated_at DESC,c.id DESC LIMIT 3`,
      ).all<any>();
      const chronological = [...latest.results].reverse();
      return Response.json(
        {
          sequence: s.mediaSequence,
          clips: chronological.map((x, index) => ({
            sequence: s.mediaSequence - (chronological.length - 1 - index),
            clipId: x.id,
            filename: x.segment_filename || null,
            mediaUrl: x.media_url || undefined,
            duration: Number(x.duration) || 5,
            replay: Boolean(x.first_aired_at),
            chatText: publicAttribution(x.chat_text),
            generatedAt: x.generated_at,
          })),
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (u.pathname === "/archive") {
      const archive = await this.env.DB.prepare(
        "SELECT c.id,c.segment_filename,c.duration,c.chat_text,c.generated_at,src.value media_url FROM clips c JOIN settings src ON src.key='clip_source:'||c.id WHERE src.value IS NOT NULL ORDER BY c.generated_at DESC,c.id DESC LIMIT 30",
      ).all<any>();
      const chronological = [...archive.results].reverse();
      return Response.json(
        {
          clips: chronological.map((x) => ({
            sequence: x.id,
            clipId: x.id,
            filename: x.segment_filename || null,
            mediaUrl: x.media_url,
            duration: Number(x.duration) || 5,
            replay: true,
            chatText: publicAttribution(x.chat_text),
            generatedAt: x.generated_at,
          })),
        },
        { headers: { "cache-control": "no-store" } },
      );
    }
    if (u.pathname === "/like-target") {
      const clipId = Number(u.searchParams.get("clip") || 0);
      const segment = u.searchParams.get("seg") || "";
      return Response.json({
        known: knownLikeTarget(
          s.window,
          s.recentClipIds || [],
          clipId,
          segment,
        ),
      });
    }
    if (u.pathname === "/bible")
      return Response.json(
        {
          style: "cursed analog late-night television",
          props: s.bible.props,
          updated_at: Math.floor(Date.now() / 1000),
        },
        { headers: { "cache-control": "no-store" } },
      );
    if (u.pathname === "/pause" && req.method === "POST") {
      s.paused = true;
      await this.save(s);
      return Response.json({ paused: true });
    }
    if (u.pathname === "/resume" && req.method === "POST") {
      s.paused = false;
      await this.save(s);
      return Response.json({ paused: false });
    }
    if (u.pathname === "/remove-clip" && req.method === "POST") {
      const { clipId } = await req.json<{ clipId: number }>();
      s.window = s.window.filter((x) => x.clipId !== clipId);
      s.recentClipIds = (s.recentClipIds || []).filter((id) => id !== clipId);
      await this.save(s);
      return Response.json({ ok: true });
    }
    if (u.pathname === "/job" && req.method === "POST") {
      const x = await req.json<any>();
      s.inFlight = Math.max(0, s.inFlight - 1);
      if (x.error) s.lastError = String(x.error).slice(0, 160);
      if (x.generation) {
        if (
          x.sourceUrl &&
          !s.window.some((e) => e.clipId === x.generation && !e.replay)
        ) {
          s.mediaSequence++;
          s.window.push({
            sequence: s.mediaSequence,
            clipId: x.generation,
            filename: null,
            mediaUrl: String(x.sourceUrl),
            duration: Number(x.duration) || 5,
            replay: false,
            chatText: String(x.chatText || ""),
            generatedAt: Math.floor(Date.now() / 1000),
          });
          s.window = s.window.slice(-6);
          await this.env.DB.batch([
            this.env.DB.prepare(
              "UPDATE clips SET first_aired_at=COALESCE(first_aired_at,?),air_count=air_count+1 WHERE id=?",
            ).bind(Math.floor(Date.now() / 1000), x.generation),
            this.env.DB.prepare(
              "UPDATE messages SET status='aired',aired_at=? WHERE job_id=(SELECT generation_job_id FROM clips WHERE id=?) AND status IN ('generating','ready')",
            ).bind(Math.floor(Date.now() / 1000), x.generation),
          ]);
        }
        s.bible = updateBible(s.bible, x.generation, x.selected || []);
        await this.env.DB.prepare(
          "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES('bible',?,?)",
        )
          .bind(JSON.stringify(s.bible), Math.floor(Date.now() / 1000))
          .run();
      }
      await this.save(s);
      return Response.json({ ok: true });
    }
    const counts = await this.env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM clips WHERE ready=1) generated_total,(SELECT COUNT(*) FROM messages) chat_messages,(SELECT COUNT(*) FROM generation_jobs WHERE status IN ('created','submitting','submitted')) generating_clips",
    ).first<any>();
    const now = s.window.at(-1);
    return Response.json(
      {
        live: !s.paused,
        paused: s.paused,
        viewers_active: Object.keys(s.viewers).length > 0,
        viewers: Object.keys(s.viewers).length,
        now_playing: now?.filename || null,
        now_generated_at: now?.generatedAt || null,
        now_replay: now?.replay || false,
        now_chat: publicAttribution(now?.chatText) || null,
        generating: null,
        buffer_clips: s.window.filter((x) => !x.replay).length,
        generating_clips: counts?.generating_clips || s.inFlight,
        buffer_secs: s.window.reduce((a, x) => a + x.duration, 0),
        generated_total: counts?.generated_total || 0,
        chat_messages: counts?.chat_messages || 0,
        last_error: s.lastError,
        recent: s.window
          .slice(-6)
          .map((x) => ({ ...x, chatText: publicAttribution(x.chatText) })),
        ts: Math.floor(Date.now() / 1000),
        bible_summary: s.bible.props,
      },
      { headers: { "cache-control": "no-store" } },
    );
  }
}
