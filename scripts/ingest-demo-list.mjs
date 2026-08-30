#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const clips = JSON.parse(await readFile(join(here, "demo-clips.json"), "utf8"));
for (const [index, clip] of clips.entries()) {
  console.log(`[${index + 1}/${clips.length}] ${clip.chat}`);
  const result = spawnSync(
    process.execPath,
    [
      join(here, "ingest-clip.mjs"),
      "--url",
      clip.url,
      "--chat",
      clip.chat,
      "--prompt",
      clip.prompt,
      "--source",
      "fal-demo",
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Demo clip ${index + 1} failed`);
}
