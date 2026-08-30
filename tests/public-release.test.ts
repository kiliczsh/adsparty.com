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
    expect(page).toContain(
      "https://wiro.ai/models/fastvideo/fast-h3?utm_source=adsparty.com",
    );
    expect(page).toMatch(/>wiro<\/a/);
  });

  it("keeps direct MP4 replay playback FIFO", () => {
    const app = read("public/app.js");
    expect(app).toContain("directQueue.slice(0, 6)");
    expect(app).not.toContain("directQueue.slice(-3)");
    expect(app).toContain("Number(clip.sequence) > directSequence");
  });

  it("returns to the latest three playable clips instead of full history", () => {
    const app = read("public/app.js");
    const worker = read("src/worker.ts");
    const station = read("src/station-do.ts");
    expect(app).toContain('fetch("/live/latest.json"');
    expect(worker).toContain('u.pathname === "/live/latest.json"');
    expect(station).toContain("ORDER BY c.generated_at DESC,c.id DESC LIMIT 3");
    expect(station).toContain("old = liveTail.results.at(-1) || null");
  });
});
