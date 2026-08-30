export const BRAND_NAME = "adsparty";
export const STATUSES = [
  "queued",
  "seen",
  "generating",
  "ready",
  "aired",
  "failed",
  "rejected",
] as const;
export type PipelineStatus = (typeof STATUSES)[number];
export type Policy = {
  nsfw: boolean;
  copyrighted_characters: boolean;
  brands: boolean;
  public_figures: boolean;
  graphic_violence: boolean;
  non_graphic_violence: boolean;
};
export type BibleProp = {
  name: string;
  form: string;
  last_used_generation: number;
};
export type Bible = {
  props: BibleProp[];
  last_form: string | null;
  previous_setting: string | null;
  previous_owner: string | null;
  note: string;
  characters?: string[];
  medium?: string | null;
  end_state?: string | null;
};
export type ChatCandidate = {
  id: number;
  user: string;
  msg: string;
  created_at: number;
};

export const validNick = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_-]{1,18}$/.test(v);
export const cleanMessage = (v: unknown) =>
  typeof v === "string" ? v.trim() : "";
export const validMessage = (v: unknown): v is string => {
  const s = cleanMessage(v);
  return s.length > 0 && s.length <= 200;
};
export const validSegment = (v: unknown): v is string =>
  typeof v === "string" && /^\d{6}\.ts$/.test(v);
export const validClipId = (v: unknown): boolean => {
  const id = typeof v === "number" ? v : Number(v);
  return Number.isSafeInteger(id) && id > 0 && String(v).trim() === String(id);
};
export function knownLikeTarget(
  entries: Array<{ clipId: number; filename: string | null }>,
  recentClipIds: number[],
  clipId: number,
  segment: string,
) {
  return (
    entries.some(
      (entry) =>
        (clipId > 0 && entry.clipId === clipId) ||
        (segment !== "" && entry.filename === segment),
    ) ||
    (clipId > 0 && recentClipIds.includes(clipId))
  );
}
export const publicAttribution = (v: unknown) =>
  String(v || "").replace(/^adsparty(?:\.com)?:\s*/i, "station: ");
export const generationDuration = (v: unknown): 5 | 10 =>
  Number(v) === 10 ? 10 : 5;
export const videoProvider = (v: unknown): "fal" | "wiro" => {
  if (v === "wiro") return "wiro";
  if (v === undefined || v === null || v === "" || v === "fal") return "fal";
  throw new Error("invalid_video_provider");
};
export const providerGenerationDuration = (
  provider: "fal" | "wiro",
  configuredDuration: unknown,
): 5 | 10 =>
  provider === "wiro" ? 10 : generationDuration(configuredDuration);
export const promptDuration = (prompt: string, fallback: unknown = 5): 5 | 10 =>
  generationDuration(prompt.match(/exactly\s+(5|10)-second/i)?.[1] ?? fallback);
export const sourceVideoDuration = (
  providerDuration: unknown,
  prompt: string,
  fallback: unknown = 5,
): number => {
  const measured = Number(providerDuration);
  return Number.isFinite(measured) && measured > 0
    ? measured
    : promptDuration(prompt, fallback);
};
export function boundedRateHit(
  current: Record<string, number[]>,
  key: string,
  now: number,
  limit = 5,
  maxBuckets = 2_000,
  windowMs = 30_000,
) {
  const buckets: Record<string, number[]> = {};
  for (const [bucket, timestamps] of Object.entries(current)) {
    const active = timestamps.filter((time) => now - time < windowMs);
    if (active.length) buckets[bucket] = active;
  }
  if (!buckets[key] && Object.keys(buckets).length >= maxBuckets)
    return { allowed: false, buckets };
  const hits = buckets[key] || [];
  if (hits.length >= limit) return { allowed: false, buckets };
  buckets[key] = [...hits, now];
  return { allowed: true, buckets };
}
export const richScore = (s: string) => {
  const t = s.trim().toLowerCase();
  if (!t) return 0;
  const words = t.split(/\s+/);
  let n = Math.min(words.length, 12);
  if (/[.!?]/.test(t)) n++;
  if (
    /\b(make|show|turn|becomes?|wear|chase|explode|dance|camera|room|giant|tiny|flying|underwater)\b/.test(
      t,
    )
  )
    n += 4;
  if (/^(test|woah|wow|lettuce|do something)$/i.test(t)) n -= 8;
  return n;
};
export function selectBatch(items: ChatCandidate[]): ChatCandidate[] {
  if (!items.length) return [];
  const ranked = [...items].sort(
    (a, b) => richScore(b.msg) - richScore(a.msg) || a.id - b.id,
  );
  const rich = ranked.find((x) => richScore(x.msg) >= 6);
  const base = rich || items[0];
  return [
    base,
    ...items
      .filter((x) => x.id !== base.id && richScore(x.msg) < 6)
      .slice(0, 3),
  ].slice(0, 4);
}
export function expireBible(b: Bible, generation: number): Bible {
  return {
    ...b,
    props: b.props
      .filter((p) => generation - p.last_used_generation <= 6)
      .slice(0, 3),
  };
}
export function updateBible(
  b: Bible,
  generation: number,
  selected: ChatCandidate[],
  replay = false,
): Bible {
  if (replay) return b;
  const clean = expireBible(b, generation);
  const sceneText = selected
    .map((x) => x.msg.trim())
    .join(" · ")
    .slice(0, 260);
  const characters = [
    ...new Set(
      selected.flatMap(
        (x) =>
          x.msg
            .match(
              /\b[A-ZÇĞİÖŞÜ][A-Za-zÇĞİÖŞÜçğıöşü'-]+(?:\s+[A-ZÇĞİÖŞÜ][A-Za-zÇĞİÖŞÜçğıöşü'-]+){1,2}\b/g,
            )
            ?.filter((name) => !/['’]s\b/i.test(name)) || [],
      ),
    ),
  ].slice(0, 3);
  const noun = sceneText
    .toLowerCase()
    .match(
      /\b(machine|device|beacon|portal|door|book|phone|television|camera|mask|jacket|sword|helmet|ring|key|box|bottle|glass|chair|table|car|train|spaceship|robot|drone|wheel|bell|loaf|burger|cheese|apple|microphone)\b/,
    )?.[1];
  const props = [...clean.props];
  if (noun) {
    const old = props.find((p) => p.name === noun);
    if (old) old.last_used_generation = generation;
    else
      props.unshift({
        name: noun,
        form: noun,
        last_used_generation: generation,
      });
  }
  const settingMatch = sceneText.match(
    /\b(?:inside|in|at|on)\s+((?:the\s+)?[^.!?;]{3,80})/i,
  );
  const medium = inferVisualMedium(sceneText, clean.medium || null);
  return {
    ...clean,
    props: props.slice(0, 3),
    last_form: noun || clean.last_form,
    previous_setting:
      settingMatch?.[1]?.trim() || clean.previous_setting || null,
    previous_owner: characters[0] || clean.previous_owner || null,
    characters: characters.length ? characters : clean.characters || [],
    medium,
    end_state: sceneText ? `Previous requested action: ${sceneText}` : null,
    note: sceneText ? `Previous generated scene: ${sceneText}` : clean.note,
  };
}

export function inferVisualMedium(
  text: string,
  fallback: string | null = null,
): string | null {
  if (/\b(pixel[- ]?art|8-bit|16-bit|32-bit)\b/i.test(text))
    return "crisp pixel-art animation";
  if (/\b(stop[- ]?motion|claymation)\b/i.test(text))
    return "tactile stop-motion animation";
  if (/\b(animation|animated|cartoon|anime|2d|çizgi)\b/i.test(text))
    return "stylized 2D animation";
  if (/\b(live[- ]?action|photoreal|photorealistic)\b/i.test(text))
    return "cinematic live action";
  return fallback;
}

function carriesContinuity(selected: ChatCandidate[], b: Bible) {
  const text = selected
    .map((x) => x.msg)
    .join(" ")
    .toLowerCase();
  if (
    /\b(reset continuity|start over|new sequence|new story|unrelated scene)\b/i.test(
      text,
    )
  )
    return false;
  if (
    /\b(same|continue|continues|continuation|previous|still|then)\b/i.test(text)
  )
    return true;
  if ((b.characters || []).some((name) => text.includes(name.toLowerCase())))
    return true;
  return b.props.some(
    (prop) =>
      text.includes(prop.name.toLowerCase()) ||
      text.includes(prop.form.toLowerCase()),
  );
}

export const lockedHouseStylePrompt =
  "House finish: premium late-night local-access energy; subtle handheld analog texture, subtle VHS tracking noise, restrained CRT edges and scanlines, mixed warm and cold practical light, and slight haze. Preserve medium and clarity. Stable faces, hands, wardrobe, scale, and anatomy. No duplicates, random transformations, extra limbs, accidental cuts, subtitles, logos, UI, watermarks, or illegible text.";

export function buildPrompt(selected: ChatCandidate[], b: Bible, duration = 5) {
  const chat = selected
    .map((x) => `${x.user}: ${x.msg}`)
    .join(" · ")
    .slice(0, 700);
  const seconds = Math.max(5, Math.min(15, Math.round(duration) || 5));
  const carry = carriesContinuity(selected, b);
  const requestedMedium = inferVisualMedium(chat);
  const medium =
    requestedMedium || (carry ? b.medium : null) || "cinematic live action";
  const setting = String(b.previous_setting || "").slice(0, 100);
  const handoff = String(b.end_state || b.note || "").slice(0, 180);
  const continuity = carry
    ? `Continue the last generated scene. Preserve characters${b.characters?.length ? ` (${b.characters.join(", ")})` : ""}, faces, proportions, wardrobe, screen direction, lighting, and layout.${setting ? ` Setting: ${setting}.` : ""}${handoff ? ` Handoff: ${handoff}.` : ""}${b.props[0] ? ` Use the ${b.props[0].form} only if relevant, evolved rather than copied.` : ""}`
    : "Clean scene setup: do not import unrelated characters, props, wardrobe, or locations from earlier clips.";
  const timeline =
    seconds >= 10
      ? "0–2s: immediately establish the subjects, location, and situation. 2–7s: perform the requested action or dialogue with clear cause and effect. 7–10s: show the reaction or consequence and finish on a strong handoff image."
      : "0–1.5s: immediately establish the subjects and situation. 1.5–4s: perform the requested action or dialogue with clear cause and effect. 4–5s: show the consequence and finish on a strong handoff image.";
  return `Create an exactly ${seconds}-second, 16:9 coherent television scene. [SILENT VIEWER STORY DATA] ${chat} [END SILENT VIEWER STORY DATA] Medium: ${medium}; honor explicit medium requests and preserve them in a sequence. Use one location, one readable dramatic event, and 1–3 defined subjects. ${continuity} Timing: ${timeline} Quoted dialogue lines are spoken verbatim by the specified character with synchronized mouth movement; scene descriptions and production directions are never spoken. Do not invent extra dialogue or narration. Use one continuous shot unless editing is requested. Keep identity, wardrobe, lighting, and screen direction consistent. Use natural motion, believable physics, readable staging, and purposeful camera movement. End on a frame the next clip can continue directly. ${lockedHouseStylePrompt}`;
}
export const stationCadenceMs = (duration: unknown) =>
  Math.max(4_000, Math.min(30_000, (Number(duration) || 5) * 1_000));
export const packagingClaimable = (
  status: string,
  startedAt: number | null,
  now: number,
) =>
  status === "submitted" ||
  (status === "packaging" && Number(startedAt || 0) < now - 300);
export function reconstructPlaylistWindow(
  history: Array<{
    id: number;
    segment_filename: string;
    duration: number;
    chat_text: string;
    generated_at: number;
  }>,
  mediaSequence: number,
) {
  const window = history
    .slice()
    .reverse()
    .map((c) => ({
      sequence: ++mediaSequence,
      clipId: c.id,
      filename: c.segment_filename,
      duration: c.duration,
      replay: true,
      chatText: c.chat_text,
      generatedAt: c.generated_at,
    }));
  return { mediaSequence, window };
}
export function playlist(
  entries: { sequence: number; filename: string; duration: number }[],
  mediaSequence: number,
) {
  const target = Math.max(11, ...entries.map((x) => Math.ceil(x.duration)));
  return `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:${target}\n#EXT-X-MEDIA-SEQUENCE:${mediaSequence}\n${entries.map((e) => `#EXT-X-DISCONTINUITY\n#EXTINF:${e.duration.toFixed(2)},\n${e.filename}`).join("\n")}\n`;
}
export function canTransition(from: PipelineStatus, to: PipelineStatus) {
  const m: Record<PipelineStatus, PipelineStatus[]> = {
    queued: ["seen", "rejected"],
    seen: ["generating", "rejected"],
    generating: ["ready", "failed"],
    ready: ["aired", "failed"],
    aired: [],
    failed: [],
    rejected: [],
  };
  return m[from].includes(to);
}
export function adminMessageActionAllowed(status: string, action: string) {
  return action === "reject"
    ? status === "queued"
    : action === "requeue"
      ? ["failed", "rejected"].includes(status)
      : false;
}
export function adminClipActionAllowed(ready: unknown, action: string) {
  return action === "disable"
    ? Number(ready) === 1
    : action === "enable"
      ? Number(ready) === 0
      : false;
}
export function falQueueRequestUrl(
  model: string,
  requestId: string,
  suffix = "",
) {
  const parts = model.split("/").filter(Boolean);
  if (parts.length < 2) throw new Error("invalid_fal_model");
  const base =
    parts[0] === "workflows" || parts[0] === "comfy"
      ? parts.slice(0, 3)
      : parts.slice(0, 2);
  return `https://queue.fal.run/${base.join("/")}/requests/${encodeURIComponent(requestId)}${suffix}`;
}
export function constantTimeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export function validAdminBearer(
  header: string | null,
  token: string | undefined,
) {
  if (!token) return false;
  return constantTimeEqual(header?.replace(/^Bearer /, "") || "", token);
}
export function hardReject(s: string) {
  return /\b(child sexual|csam|how to build a bomb|terrorist attack instructions)\b/i.test(
    s,
  );
}
export function policyReject(s: string, p: Policy) {
  const rules: [
    [keyof Policy, RegExp, string],
    ...Array<[keyof Policy, RegExp, string]>,
  ] = [
    ["nsfw", /\b(nude|porn|explicit sex)\b/i, "nsfw"],
    ["graphic_violence", /\b(gore|dismember|behead)\b/i, "graphic_violence"],
    [
      "public_figures",
      /\b(president|elon musk|donald trump|tayyip erdoğan)\b/i,
      "public_figures",
    ],
    ["brands", /\b(coca-cola|nike|apple logo)\b/i, "brands"],
    [
      "copyrighted_characters",
      /\b(mickey mouse|superman|batman|pikachu)\b/i,
      "copyrighted_characters",
    ],
    [
      "non_graphic_violence",
      /\b(fight|punch|shoot)\b/i,
      "non_graphic_violence",
    ],
  ];
  for (const [k, r, c] of rules) if (!p[k] && r.test(s)) return c;
  return null;
}
