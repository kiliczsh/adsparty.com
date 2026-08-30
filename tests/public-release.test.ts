import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("public release contract", () => {
  it("documents every application secret without committing values", () => {
    const example = read(".env.example");
    for (const name of [
      "FAL_KEY",
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
});
