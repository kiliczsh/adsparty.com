import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const script = resolve(root, "scripts/ingest-clip.mjs");

describe("manual clip ingest guardrails", () => {
  it("documents required operator inputs without network access", () => {
    const result = spawnSync(process.execPath, [script, "--help"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("--url");
    expect(result.stdout).toContain("--chat");
    expect(result.stdout).toContain("--prompt");
  });

  it("rejects non-HTTPS sources before invoking Wrangler", () => {
    const result = spawnSync(
      process.execPath,
      [
        script,
        "--url",
        "http://example.com/a.mp4",
        "--chat",
        "tv: scene",
        "--prompt",
        "scene",
      ],
      { encoding: "utf8" },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Only HTTPS source URLs are accepted");
  });

  it("keeps the demo manifest unique, HTTPS-only and viewer-safe", () => {
    const clips = JSON.parse(
      readFileSync(resolve(root, "scripts/demo-clips.json"), "utf8"),
    ) as Array<{ url: string; chat: string; prompt: string }>;
    expect(clips).toHaveLength(8);
    expect(new Set(clips.map((x) => x.url)).size).toBe(clips.length);
    for (const clip of clips) {
      expect(new URL(clip.url).protocol).toBe("https:");
      expect(clip.chat.length).toBeLessThanOrEqual(200);
      expect(clip.prompt.length).toBeLessThanOrEqual(4000);
    }
  });
});
