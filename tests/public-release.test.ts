import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("public release contract", () => {
  it("documents every application secret without committing values", () => {
    const example = read(".env.example");
    for (const name of [
      "FAL_KEY",
      "WIRO_API_KEY",
      "WIRO_API_SECRET",
      "DIRECTOR_API_KEY",
      "TURNSTILE_SECRET_KEY",
      "VIEWER_SIGNING_KEY",
      "ADMIN_TOKEN",
      "PACKAGER_TOKEN",
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
    ])
      expect(example).toContain(`${name}=\n`);
  });

  it("keeps manual ingestion aligned with production media resources", () => {
    const wrangler = read("wrangler.jsonc");
    const ingest = read("scripts/ingest-clip.mjs");
    const database = wrangler.match(/"database_name":\s*"([^"]+)"/)?.[1];
    const bucket = wrangler.match(/"bucket_name":\s*"([^"]+)"/)?.[1];
    expect(database).toBeTruthy();
    expect(bucket).toBeTruthy();
    expect(ingest).toContain(`database: "${database}"`);
    expect(ingest).toContain(`bucket: "${bucket}"`);
  });

  it("pins third-party browser and CI code", () => {
    const page = read("public/index.html");
    const workflow = read(".github/workflows/ci.yml");
    expect(page).toMatch(/hls\.min\.js[\s\S]+integrity="sha384-[^"]+"/);
    expect(workflow).toContain("permissions:\n  contents: read");
    expect(workflow).not.toMatch(/uses:\s+[^\s]+@v\d+/);
  });

  it("centralizes the viewer-facing legacy brand", () => {
    const app = read("public/app.js");
    const index = read("public/index.html");
    expect(app.match(/televole/gi)).toHaveLength(1);
    expect(index).not.toMatch(/televole/i);
  });

  it("links the Wiro FastH3 integration from the viewer footer", () => {
    const page = read("public/index.html");
    const worker = read("src/worker.ts");
    expect(page).toContain(
      "https://wiro.ai/models/fastvideo/fast-h3?utm_source=adsparty.com",
    );
    expect(page).toMatch(/>wiro<\/a/);
    expect(worker).toContain("https://*.wiro.ai");
  });

  it("keeps direct MP4 replay playback FIFO", () => {
    const app = read("public/app.js");
    expect(app).toContain("directQueue.slice(0, 6)");
    expect(app).not.toContain("directQueue.slice(-3)");
    expect(app).toContain("Number(clip.sequence) > directSequence");
  });

  it("opens the newest live clip and exposes a bounded chronological archive", () => {
    const app = read("public/app.js");
    const worker = read("src/worker.ts");
    const station = read("src/station-do.ts");
    expect(app).toContain('fetch("/live/latest.json"');
    expect(app).toContain("const target = liveTail.at(-1)");
    expect(app).toContain('fetch("/live/archive.json"');
    expect(worker).toContain('u.pathname === "/live/latest.json"');
    expect(worker).toContain('u.pathname === "/live/archive.json"');
    expect(station).toContain("ORDER BY c.generated_at DESC,c.id DESC LIMIT 3");
    expect(station).toContain(
      "ORDER BY c.generated_at DESC,c.id DESC LIMIT 30",
    );
  });

  it("offers live, recorded loop, and three-video rewind modes", () => {
    const app = read("public/app.js");
    const page = read("public/index.html");
    expect(page).toContain('data-playback="rec"');
    expect(page).toContain('data-playback="live"');
    expect(page).toContain('data-playback="rewind"');
    expect(app).toContain('playbackMode !== "live"');
    expect(app).toContain("% recordedClips.length");
    expect(app).toContain("(base - 3 + clips.length) % clips.length");
    expect(app).toContain("previousRecordedClip");
  });

  it("serializes packaging on a warm dedicated standard-2 container", () => {
    const wrangler = read("wrangler.jsonc");
    const container = read("src/media-container.ts");
    const worker = read("src/worker.ts");
    const station = read("src/station-do.ts");
    expect(wrangler).toContain('"binding": "PACKAGING_QUEUE"');
    expect(wrangler).toContain('"queue": "televole-packaging"');
    expect(wrangler).toContain('"max_concurrency": 1');
    expect(wrangler).toContain('"instance_type": "standard-2"');
    expect(container).toContain('sleepAfter = "10m"');
    expect(worker).toContain('batch.queue === "televole-packaging"');
    expect(station).toContain('u.pathname === "/archive-ready"');
  });
});
