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
type SocketAttachment = {
  viewerId: string;
  lastSyncAt: number;
  lastWatchAt: number;
};
type PublicEvent =
  | {
      type: "chat:new";
      message: {
        id: number;
        user: string;
        msg: string;
        created_at: number;
        status: string;
      };
    }
  | { type: "like:update"; clipId: number; likes: number }
  | { type: "viewers:update"; viewers: number };
type State = {
  mediaSequence: number;
  window: Entry[];
  recentClipIds?: number[];
  rerunCursorGeneratedAt?: number;
  rerunCursorClipId?: number;
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
  private socketViewerIds(exclude?: WebSocket) {
    const viewers = new Set<string>();
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === exclude) continue;
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      if (attachment?.viewerId) viewers.add(attachment.viewerId);
    }
    return viewers;
  }
  private viewerCount(s: State, exclude?: WebSocket) {
    return new Set([
      ...Object.keys(s.viewers),
      ...this.socketViewerIds(exclude),
    ]).size;
  }
  private send(socket: WebSocket, event: unknown) {
    try {
      socket.send(JSON.stringify(event));
    } catch {
      // A closing socket is removed by the runtime; one failed fan-out must not
      // interrupt the station clock or delivery to the remaining viewers.
    }
  }
  private broadcast(event: unknown) {
    for (const socket of this.ctx.getWebSockets()) this.send(socket, event);
  }
  private publicMeta(s: State) {
    return {
      sequence: s.mediaSequence,
      clips: s.window.map((entry) => ({
        ...entry,
        chatText: publicAttribution(entry.chatText),
      })),
    };
  }
  private broadcastMeta(s: State) {
    if (!this.ctx.getWebSockets().length) return;
    this.broadcast({ type: "station:meta", meta: this.publicMeta(s) });
  }
  private async sendChatSnapshot(
    socket?: WebSocket,
    since = 0,
    mine: number[] = [],
  ) {
    const query = since
      ? "SELECT id,user,msg,created_at,status FROM messages WHERE id>? ORDER BY id LIMIT 50"
      : "SELECT * FROM (SELECT id,user,msg,created_at,status FROM messages ORDER BY id DESC LIMIT 50) ORDER BY id";
    const messages = await this.env.DB.prepare(query)
      .bind(...(since ? [since] : []))
      .all();
    let states: null | Record<string, string> = null;
    if (mine.length) {
      const rows = await this.env.DB.prepare(
        `SELECT id,status FROM messages WHERE id IN (${mine.map(() => "?").join(",")})`,
      )
        .bind(...mine)
        .all<{ id: number; status: string }>();
      states = Object.fromEntries(
        rows.results.map((row) => [String(row.id), row.status]),
      );
    }
    const s = await this.state();
    const event = {
      type: "chat:sync",
      msgs: messages.results,
      mine: states,
      viewers: this.viewerCount(s),
    };
    if (socket) this.send(socket, event);
    else this.broadcast(event);
  }
  private async broadcastChatStates() {
    const rows = await this.env.DB.prepare(
      "SELECT id,status FROM messages WHERE status IN ('queued','seen','generating','ready') OR id IN (SELECT id FROM messages ORDER BY id DESC LIMIT 50) ORDER BY id DESC LIMIT 100",
    ).all<{ id: number; status: string }>();
    const s = await this.state();
    this.broadcast({
      type: "chat:states",
      states: Object.fromEntries(
        rows.results.map((row) => [String(row.id), row.status]),
      ),
      viewers: this.viewerCount(s),
    });
  }
  private async sendLikeSnapshot(socket: WebSocket, clipId: number) {
    const s = await this.state();
    if (!knownLikeTarget(s.window, s.recentClipIds || [], clipId, "")) {
      this.send(socket, { type: "like:update", clipId, likes: 0 });
      return;
    }
    const likes = await this.env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM likes WHERE clip_id=?)+(SELECT COUNT(*) FROM like_events WHERE clip_id=?) n",
    )
      .bind(clipId, clipId)
      .first<number>("n");
    this.send(socket, { type: "like:update", clipId, likes: likes || 0 });
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
    if (s.window.length) {
      const clipIds = [
        ...new Set(s.window.map((entry) => entry.clipId)),
      ].filter((id) => Number.isInteger(id) && id > 0);
      if (clipIds.length) {
        const placeholders = clipIds.map(() => "?").join(",");
        const active = await this.env.DB.prepare(
          `SELECT id FROM clips WHERE ready=1 AND id IN (${placeholders})`,
        )
          .bind(...clipIds)
          .all<{ id: number }>();
        const activeIds = new Set(active.results.map((clip) => clip.id));
        const removed = s.window.filter(
          (entry) => !activeIds.has(entry.clipId),
        ).length;
        if (removed) {
          s.window = s.window.filter((entry) => activeIds.has(entry.clipId));
          s.recentClipIds = (s.recentClipIds || []).filter((id) =>
            activeIds.has(id),
          );
          console.log(
            JSON.stringify({ event: "station_window_pruned", clips: removed }),
          );
        }
      }
    }
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
      const lastReplay = [...s.window]
        .reverse()
        .find((entry) => entry.replay && entry.clipId > 0);
      const cursorGeneratedAt = Number(
        s.rerunCursorGeneratedAt ?? lastReplay?.generatedAt ?? 0,
      );
      const cursorClipId = Number(
        s.rerunCursorClipId ?? lastReplay?.clipId ?? 0,
      );
      const archived =
        "c.ready=1 AND c.segment_filename IS NOT NULL AND c.r2_key IS NOT NULL";
      let old = await this.env.DB.prepare(
        `SELECT c.id,c.segment_filename,c.duration,c.chat_text,c.generated_at,NULL media_url FROM clips c WHERE ${archived} AND (COALESCE(c.generated_at,0)>? OR (COALESCE(c.generated_at,0)=? AND c.id>?)) ORDER BY COALESCE(c.generated_at,0) ASC,c.id ASC LIMIT 1`,
      )
        .bind(cursorGeneratedAt, cursorGeneratedAt, cursorClipId)
        .first<any>();
      if (!old)
        old = await this.env.DB.prepare(
          `SELECT c.id,c.segment_filename,c.duration,c.chat_text,c.generated_at,NULL media_url FROM clips c WHERE ${archived} ORDER BY COALESCE(c.generated_at,0) ASC,c.id ASC LIMIT 1`,
        ).first<any>();
      if (!old) {
        old = await this.env.DB.prepare(
          "SELECT c.id,c.segment_filename,c.duration,c.chat_text,c.generated_at,src.value media_url FROM clips c JOIN settings src ON src.key='clip_source:'||c.id WHERE src.value IS NOT NULL AND (COALESCE(c.generated_at,0)>? OR (COALESCE(c.generated_at,0)=? AND c.id>?)) ORDER BY COALESCE(c.generated_at,0) ASC,c.id ASC LIMIT 1",
        )
          .bind(cursorGeneratedAt, cursorGeneratedAt, cursorClipId)
          .first<any>();
        if (!old)
          old = await this.env.DB.prepare(
            "SELECT c.id,c.segment_filename,c.duration,c.chat_text,c.generated_at,src.value media_url FROM clips c JOIN settings src ON src.key='clip_source:'||c.id WHERE src.value IS NOT NULL ORDER BY COALESCE(c.generated_at,0) ASC,c.id ASC LIMIT 1",
          ).first<any>();
      }
      if (old) {
        s.rerunCursorGeneratedAt = Number(old.generated_at) || 0;
        s.rerunCursorClipId = Number(old.id) || 0;
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
      "SELECT id,status,fal_request_id,expanded_prompt,provider FROM generation_jobs WHERE (status='submitted' AND started_at<?) OR (status='source_ready' AND started_at<?) OR (status='packaging' AND started_at<?) ORDER BY CASE WHEN status IN ('source_ready','packaging') THEN 0 ELSE 1 END,created_at DESC LIMIT 2",
    )
      .bind(now - 90, now - 90, now - 300)
      .all<{
        id: string;
        status: string;
        fal_request_id: string | null;
        expanded_prompt: string;
        provider: "fal" | "wiro";
      }>();
    for (const job of stale.results) {
      if (job.status === "source_ready" || job.status === "packaging") {
        const packagingClaim =
          job.status === "packaging"
            ? await this.env.DB.prepare(
                "UPDATE generation_jobs SET status='source_ready',started_at=?,retry_count=retry_count+1,error='media_packaging_stale' WHERE id=? AND status='packaging' RETURNING id",
              )
                .bind(now, job.id)
                .first()
            : await this.env.DB.prepare(
                "UPDATE generation_jobs SET started_at=? WHERE id=? AND status='source_ready' AND started_at<? RETURNING id",
              )
                .bind(now, job.id, now - 90)
                .first();
        if (!packagingClaim) continue;
        await this.env.PACKAGING_QUEUE.send({ jobId: job.id });
        continue;
      }
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
    if (this.ctx.getWebSockets().length) {
      try {
        this.broadcastMeta(s);
        await this.broadcastChatStates();
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "realtime_snapshot_failed",
            error: String(error).slice(0, 160),
          }),
        );
      }
    }
  }
  async fetch(req: Request) {
    const u = new URL(req.url);
    const s = await this.state();
    const viewer = req.headers.get("x-viewer-id");
    if (viewer) {
      s.viewers[viewer] = Math.floor(Date.now() / 1000);
      await this.save(s);
    }
    if (u.pathname === "/ws") {
      if (req.method !== "GET")
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { allow: "GET" },
        });
      if (req.headers.get("upgrade")?.toLowerCase() !== "websocket")
        return new Response("WebSocket upgrade required", { status: 426 });
      if (!viewer) return new Response("Missing viewer", { status: 401 });
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.serializeAttachment({
        viewerId: viewer,
        lastSyncAt: 0,
        lastWatchAt: 0,
      } satisfies SocketAttachment);
      this.ctx.acceptWebSocket(server, ["viewer"]);
      this.send(server, {
        type: "connected",
        viewers: this.viewerCount(s),
      });
      this.send(server, { type: "station:meta", meta: this.publicMeta(s) });
      this.broadcast({
        type: "viewers:update",
        viewers: this.viewerCount(s),
      } satisfies PublicEvent);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (u.pathname === "/broadcast" && req.method === "POST") {
      const event = await req.json<PublicEvent>();
      if (
        !event ||
        !["chat:new", "like:update"].includes(String(event.type || ""))
      )
        return Response.json({ error: "invalid_event" }, { status: 400 });
      this.broadcast(event);
      return Response.json({ delivered: this.ctx.getWebSockets().length });
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
      return Response.json(this.publicMeta(s), {
        headers: { "cache-control": "no-store" },
      });
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
            mediaUrl: x.segment_filename ? undefined : x.media_url || undefined,
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
        "SELECT c.id,c.segment_filename,c.duration,c.chat_text,c.generated_at,src.value media_url FROM clips c LEFT JOIN settings src ON src.key='clip_source:'||c.id WHERE (c.ready=1 AND c.segment_filename IS NOT NULL AND c.r2_key IS NOT NULL) OR src.value IS NOT NULL ORDER BY c.generated_at DESC,c.id DESC LIMIT 30",
      ).all<any>();
      const chronological = [...archive.results].reverse();
      return Response.json(
        {
          clips: chronological.map((x) => ({
            sequence: x.id,
            clipId: x.id,
            filename: x.segment_filename || null,
            mediaUrl: x.segment_filename ? undefined : x.media_url || undefined,
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
      this.broadcastMeta(s);
      return Response.json({ ok: true });
    }
    if (u.pathname === "/archive-ready" && req.method === "POST") {
      const x = await req.json<{
        clipId: number;
        filename: string;
        duration: number;
      }>();
      if (!/^\d{6}\.ts$/.test(x.filename))
        return Response.json({ error: "invalid_segment" }, { status: 400 });
      let upgraded = 0;
      s.window = s.window.map((entry) => {
        if (entry.clipId !== Number(x.clipId)) return entry;
        upgraded++;
        return {
          ...entry,
          filename: x.filename,
          mediaUrl: undefined,
          duration: Number(x.duration) || entry.duration,
        };
      });
      await this.save(s);
      this.broadcastMeta(s);
      return Response.json({ ok: true, upgraded });
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
      this.broadcastMeta(s);
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
        viewers_active: this.viewerCount(s) > 0,
        viewers: this.viewerCount(s),
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
  async webSocketMessage(socket: WebSocket, message: ArrayBuffer | string) {
    if (typeof message !== "string" || message.length > 2_048) return;
    try {
      const input = JSON.parse(message) as {
        type?: string;
        since?: unknown;
        mine?: unknown;
        clipId?: unknown;
      };
      const attachment =
        socket.deserializeAttachment() as SocketAttachment | null;
      const now = Date.now();
      if (input.type === "watch") {
        if (attachment && now - attachment.lastWatchAt < 250) return;
        const clipId = Number(input.clipId);
        if (!Number.isSafeInteger(clipId) || clipId <= 0) return;
        if (attachment)
          socket.serializeAttachment({ ...attachment, lastWatchAt: now });
        await this.sendLikeSnapshot(socket, clipId);
        return;
      }
      if (input.type !== "sync") return;
      if (attachment && now - attachment.lastSyncAt < 2_000) return;
      if (attachment)
        socket.serializeAttachment({ ...attachment, lastSyncAt: now });
      const since =
        typeof input.since === "number" &&
        Number.isSafeInteger(input.since) &&
        input.since >= 0
          ? input.since
          : 0;
      const mine = Array.isArray(input.mine)
        ? input.mine
            .filter(
              (id): id is number =>
                typeof id === "number" && Number.isSafeInteger(id) && id > 0,
            )
            .slice(-50)
        : [];
      await this.sendChatSnapshot(socket, since, mine);
    } catch {
      this.send(socket, { type: "error", error: "invalid_message" });
    }
  }
  async webSocketClose(socket: WebSocket) {
    const attachment =
      socket.deserializeAttachment() as SocketAttachment | null;
    const s = await this.state();
    if (
      attachment?.viewerId &&
      ![...this.socketViewerIds(socket)].includes(attachment.viewerId)
    ) {
      delete s.viewers[attachment.viewerId];
      await this.save(s);
    }
    this.broadcast({
      type: "viewers:update",
      viewers: this.viewerCount(s, socket),
    } satisfies PublicEvent);
  }
  async webSocketError(socket: WebSocket) {
    await this.webSocketClose(socket);
  }
}
