import http from "node:http";
import { spawn } from "node:child_process";
import { timingSafeEqual } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createWriteStream, createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_SOURCE_BYTES = Number(
  process.env.MAX_SOURCE_BYTES || 300 * 1024 * 1024,
);
const DOWNLOAD_TIMEOUT_MS = Number(process.env.DOWNLOAD_TIMEOUT_MS || 120_000);
const MEDIA_TIMEOUT_MS = Number(process.env.MEDIA_TIMEOUT_MS || 180_000);
const allowedHosts = (process.env.PACKAGER_SOURCE_HOSTS || ".fal.media")
  .split(",")
  .map((x) => x.trim().toLowerCase())
  .filter(Boolean);

export function validBearer(header, secret) {
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice(7)),
    expected = Buffer.from(secret);
  return (
    supplied.length === expected.length && timingSafeEqual(supplied, expected)
  );
}

export function validSource(value) {
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      allowedHosts.some((host) =>
        host.startsWith(".") ? u.hostname.endsWith(host) : u.hostname === host,
      )
    );
  } catch {
    return false;
  }
}

const run = (cmd, args) =>
  new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "",
      err = "",
      done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      p.kill("SIGKILL");
      reject(new Error("media command timed out"));
    }, MEDIA_TIMEOUT_MS);
    p.stdout.on("data", (x) => (out += x));
    p.stderr.on("data", (x) => (err += x));
    p.on("error", (e) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      reject(e);
    });
    p.on("close", (c) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      c === 0 ? resolve(out) : reject(new Error(err.slice(-500)));
    });
  });

async function download(url, path) {
  if (!validSource(url)) throw new Error("source not allowed");
  const r = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });
  if (!r.ok || !r.body) throw new Error("download failed");
  const length = Number(r.headers.get("content-length") || 0);
  if (length > MAX_SOURCE_BYTES) throw new Error("source too large");
  let bytes = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      bytes += chunk.length;
      callback(
        bytes > MAX_SOURCE_BYTES ? new Error("source too large") : null,
        chunk,
      );
    },
  });
  await pipeline(r.body, meter, createWriteStream(path));
}

async function packageVideo(url, id) {
  const dir = await mkdtemp(join(tmpdir(), "adsparty-"));
  const input = join(dir, `${id}.mp4`),
    output = join(dir, `${id}.ts`);
  try {
    await download(url, input);
    const duration = Number(
      await run("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        input,
      ]),
    );
    try {
      await run("ffmpeg", [
        "-y",
        "-i",
        input,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c",
        "copy",
        "-bsf:v",
        "h264_mp4toannexb",
        "-f",
        "mpegts",
        output,
      ]);
    } catch {
      await run("ffmpeg", [
        "-y",
        "-i",
        input,
        "-map",
        "0:v:0",
        "-map",
        "0:a?",
        "-c:v",
        "libx264",
        "-profile:v",
        "main",
        "-level",
        "3.1",
        "-pix_fmt",
        "yuv420p",
        "-r",
        "30",
        "-g",
        "60",
        "-keyint_min",
        "60",
        "-sc_threshold",
        "0",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-b:a",
        "128k",
        "-f",
        "mpegts",
        output,
      ]);
    }
    return { dir, output, duration: Number.isFinite(duration) ? duration : 10 };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}

export const server = http.createServer(async (req, res) => {
  if (req.url === "/ready") {
    res.end("ok");
    return;
  }
  if (req.url !== "/package" || req.method !== "POST") {
    res.writeHead(404).end();
    return;
  }
  if (!validBearer(req.headers.authorization, process.env.PACKAGER_TOKEN)) {
    res
      .writeHead(401, { "content-type": "application/json" })
      .end(JSON.stringify({ error: "unauthorized" }));
    return;
  }
  let raw = "";
  req.setEncoding("utf8");
  for await (const c of req) {
    raw += c;
    if (raw.length > 4096) {
      res.writeHead(413).end();
      return;
    }
  }
  let work;
  try {
    const x = JSON.parse(raw);
    if (
      !/^[0-9a-f-]{20,50}$/i.test(x.generation_id) ||
      !validSource(x.source_url)
    )
      throw new Error("invalid request");
    work = await packageVideo(x.source_url, x.generation_id);
    res.writeHead(200, {
      "content-type": "video/mp2t",
      "x-media-duration": String(work.duration),
      "cache-control": "no-store",
    });
    await pipeline(createReadStream(work.output), res);
  } catch {
    if (!res.headersSent)
      res
        .writeHead(502, {
          "content-type": "application/json",
          "cache-control": "no-store",
        })
        .end(JSON.stringify({ error: "packaging_failed" }));
    else res.destroy();
  } finally {
    if (work) await rm(work.dir, { recursive: true, force: true });
  }
});

if (process.env.NODE_ENV !== "test")
  server.listen(Number(process.env.PORT || 8080), "0.0.0.0");
