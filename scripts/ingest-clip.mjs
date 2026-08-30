#!/usr/bin/env node
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { spawnSync } from "node:child_process";

const MAX_BYTES = 300 * 1024 * 1024;
const usage = `Usage:
  npm run ingest:clip -- --url https://.../video.mp4 --chat "nick: request" --prompt "director prompt"

Options:
  --source NAME       Clip source label (default: manual)
  --database NAME     D1 database (default: televole-db)
  --bucket NAME       R2 bucket (default: televole-media)
  --help              Show this help`;

function args(argv) {
  const out = {
    source: "manual",
    database: "televole-db",
    bucket: "televole-media",
  };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (key === "--help") return { help: true };
    if (!key.startsWith("--") || !argv[i + 1])
      throw new Error(`Invalid argument: ${key}`);
    out[key.slice(2)] = argv[++i];
  }
  return out;
}
function run(command, argv, { json = false } = {}) {
  const r = spawnSync(command, argv, {
    encoding: "utf8",
    stdio: json ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (r.error) throw r.error;
  if (r.status !== 0)
    throw new Error(`${command} exited with status ${r.status}`);
  return json ? JSON.parse(r.stdout) : null;
}
function sql(v) {
  return `'${String(v).replaceAll("'", "''")}'`;
}
function d1(database, statement) {
  const result = run(
    "npx",
    [
      "wrangler",
      "d1",
      "execute",
      database,
      "--remote",
      "--json",
      "--command",
      statement,
    ],
    { json: true },
  );
  return result.flatMap((x) => x.results || []);
}
function probe(file) {
  const r = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "format=duration:stream=codec_type,codec_name",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8" },
  );
  if (r.error?.code === "ENOENT") throw new Error("ffprobe is required");
  if (r.status !== 0) throw new Error("Input is not readable media");
  return JSON.parse(r.stdout);
}

async function main() {
  const x = args(process.argv.slice(2));
  if (x.help) {
    console.log(usage);
    return;
  }
  if (!x.url || !x.chat || !x.prompt)
    throw new Error("--url, --chat and --prompt are required");
  const url = new URL(x.url);
  if (url.protocol !== "https:")
    throw new Error("Only HTTPS source URLs are accepted");
  if (x.chat.length > 500 || x.prompt.length > 4000)
    throw new Error("Chat or prompt is too long");
  const jobId = `manual-${createHash("sha256").update(`${url}\n${x.chat}\n${x.prompt}`).digest("hex").slice(0, 24)}`;
  const existing = d1(
    x.database,
    `SELECT id,segment_filename,ready FROM clips WHERE generation_job_id=${sql(jobId)}`,
  )[0];
  if (existing?.ready) {
    console.log(
      JSON.stringify({
        ok: true,
        id: existing.id,
        segment: existing.segment_filename,
        idempotent: true,
      }),
    );
    return;
  }
  const dir = await mkdtemp(join(tmpdir(), "adsparty-ingest-"));
  const input = join(dir, "source.mp4"),
    output = join(dir, "segment.ts");
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok || !response.body)
      throw new Error(`Download failed (${response.status})`);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_BYTES) throw new Error("Source exceeds 300 MB");
    let received = 0;
    const limiter = new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        callback(
          received > MAX_BYTES ? new Error("Source exceeds 300 MB") : null,
          chunk,
        );
      },
    });
    await pipeline(
      Readable.fromWeb(response.body),
      limiter,
      createWriteStream(input, { flags: "wx" }),
    );
    const media = probe(input);
    const video = media.streams?.find((s) => s.codec_type === "video");
    const audio = media.streams?.find((s) => s.codec_type === "audio");
    if (!video) throw new Error("Source has no video stream");
    const duration = Number(media.format?.duration);
    if (!Number.isFinite(duration) || duration < 1 || duration > 30)
      throw new Error("Clip duration must be between 1 and 30 seconds");
    const compatible =
      video.codec_name === "h264" && (!audio || audio.codec_name === "aac");
    const ffargs = compatible
      ? [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          input,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          "-c",
          "copy",
          "-bsf:v",
          "h264_mp4toannexb",
          "-f",
          "mpegts",
          output,
        ]
      : [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          input,
          "-map",
          "0:v:0",
          "-map",
          "0:a:0?",
          "-c:v",
          "libx264",
          "-profile:v",
          "main",
          "-level",
          "4.0",
          "-pix_fmt",
          "yuv420p",
          "-g",
          "50",
          "-sc_threshold",
          "0",
          "-c:a",
          "aac",
          "-b:a",
          "128k",
          "-ar",
          "48000",
          "-f",
          "mpegts",
          output,
        ];
    run("ffmpeg", ffargs);
    const packaged = probe(output);
    const packagedDuration = Number(packaged.format?.duration) || duration;
    const now = Math.floor(Date.now() / 1000);
    d1(
      x.database,
      `INSERT OR IGNORE INTO generation_jobs(id,status,expanded_prompt,created_at,started_at,ended_at) VALUES(${sql(jobId)},'ready',${sql(x.prompt)},${now},${now},${now})`,
    );
    let clip = d1(
      x.database,
      `INSERT OR IGNORE INTO clips(generation_job_id,prompt,chat_text,generated_at,duration,source,ready) VALUES(${sql(jobId)},${sql(x.prompt)},${sql(x.chat)},${now},${packagedDuration},${sql(x.source)},0); SELECT id,ready FROM clips WHERE generation_job_id=${sql(jobId)}`,
    ).at(-1);
    if (!clip) throw new Error("Could not reserve clip id");
    const filename = `${String(clip.id).padStart(6, "0")}.ts`;
    const key = `segments/${filename}`;
    run("npx", [
      "wrangler",
      "r2",
      "object",
      "put",
      `${x.bucket}/${key}`,
      "--remote",
      "--file",
      output,
      "--content-type",
      "video/mp2t",
      "--cache-control",
      "public,max-age=31536000,immutable",
      "--force",
    ]);
    d1(
      x.database,
      `UPDATE clips SET segment_filename=${sql(filename)},r2_key=${sql(key)},duration=${packagedDuration},ready=1 WHERE id=${Number(clip.id)} AND generation_job_id=${sql(jobId)}`,
    );
    console.log(
      JSON.stringify({
        ok: true,
        id: clip.id,
        segment: filename,
        duration: packagedDuration,
        remuxed: compatible,
      }),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(`ingest failed: ${error.message}`);
  process.exitCode = 1;
});
