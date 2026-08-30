export const WIRO_RUN_ENDPOINT = "https://api.wiro.ai/v1/Run/fastvideo/fast-h3";
export const WIRO_DETAIL_ENDPOINT = "https://api.wiro.ai/v1/Task/Detail";

export const WIRO_RUNNING_STATUSES = [
  "task_queue",
  "task_accept",
  "task_assign",
  "task_preprocess_start",
  "task_preprocess_end",
  "task_start",
  "task_output",
] as const;
export const WIRO_COMPLETED_STATUS = "task_postprocess_end";
export const WIRO_CANCELLED_STATUS = "task_cancel";

export type WiroCredentials = {
  apiKey: string;
  apiSecret: string;
};

export type WiroRunInput = {
  prompt: string;
  duration: string;
  resolution: "480P" | "768P";
  ratio: "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "21:9";
  seed: number;
  callbackUrl?: string;
};

export type WiroSubmission = {
  taskid: string;
  socketaccesstoken: string;
};

export type WiroOutput = {
  id: string;
  name: string;
  contenttype: string;
  size: string;
  url: string;
};

export type WiroTask = {
  id: string;
  socketaccesstoken: string;
  status: string;
  outputs: WiroOutput[];
};

type WiroResponse = {
  result: boolean;
  errors: unknown[];
};

type WiroSubmitResponse = WiroResponse & Partial<WiroSubmission>;
type WiroDetailResponse = WiroResponse & {
  tasklist?: WiroTask[];
};

function apiErrorCode(errors: unknown[]) {
  const first = errors[0];
  const raw =
    typeof first === "string"
      ? first
      : first && typeof first === "object"
        ? String(
            (first as Record<string, unknown>).code ||
              (first as Record<string, unknown>).message ||
              (first as Record<string, unknown>).error ||
              "",
          )
        : "";
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return normalized ? `wiro_api_${normalized}` : "wiro_api_error";
}

const durations = new Set(
  Array.from({ length: 11 }, (_, index) => String(index + 5)),
);
const resolutions = new Set(["480P", "768P"]);
const ratios = new Set(["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"]);
const runningStatuses = new Set<string>(WIRO_RUNNING_STATUSES);

const hex = (bytes: ArrayBuffer) =>
  [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export async function wiroSignature(
  apiKey: string,
  apiSecret: string,
  nonce: string,
) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(apiKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hex(
    await crypto.subtle.sign("HMAC", key, encoder.encode(apiSecret + nonce)),
  );
}

const randomNonce = () => {
  const value = new Uint32Array(1);
  crypto.getRandomValues(value);
  return String(value[0]);
};

async function wiroHeaders(credentials: WiroCredentials) {
  if (!credentials.apiKey || !credentials.apiSecret)
    throw new Error("wiro_not_configured");
  const nonce = randomNonce();
  return {
    "x-api-key": credentials.apiKey,
    "x-nonce": nonce,
    "x-signature": await wiroSignature(
      credentials.apiKey,
      credentials.apiSecret,
      nonce,
    ),
  };
}

async function wiroPost<T extends WiroResponse>(
  endpoint: string,
  payload: Record<string, unknown>,
  credentials: WiroCredentials,
  fetcher: typeof fetch,
): Promise<T> {
  const form = new FormData();
  for (const [name, value] of Object.entries(payload))
    form.set(name, String(value));
  const response = await fetcher(endpoint, {
    method: "POST",
    headers: await wiroHeaders(credentials),
    body: form,
  });
  if (!response.ok) throw new Error(`wiro_http_${response.status}`);
  const result = (await response.json()) as T;
  if (!Array.isArray(result.errors)) throw new Error("wiro_api_error");
  if (!result.result || result.errors.length)
    throw new Error(apiErrorCode(result.errors));
  return result;
}

function validateRunInput(input: WiroRunInput) {
  if (!input.prompt.trim()) throw new Error("wiro_invalid_prompt");
  if (!durations.has(input.duration)) throw new Error("wiro_invalid_duration");
  if (!resolutions.has(input.resolution))
    throw new Error("wiro_invalid_resolution");
  if (!ratios.has(input.ratio)) throw new Error("wiro_invalid_ratio");
  if (!Number.isFinite(input.seed)) throw new Error("wiro_invalid_seed");
}

export function wiroRunInput(
  prompt: string,
  duration: unknown,
  resolution: unknown = "480P",
  ratio: unknown = "16:9",
  seed: unknown = 1000,
): WiroRunInput {
  const input = {
    prompt,
    duration: String(duration),
    resolution: String(resolution),
    ratio: String(ratio),
    seed: Number(seed),
  } as WiroRunInput;
  validateRunInput(input);
  return input;
}

export async function submitWiroTask(
  input: WiroRunInput,
  credentials: WiroCredentials,
  fetcher: typeof fetch = fetch,
): Promise<WiroSubmission> {
  validateRunInput(input);
  const payload: Record<string, unknown> = {
    prompt: input.prompt,
    duration: input.duration,
    resolution: input.resolution,
    ratio: input.ratio,
    seed: input.seed,
  };
  if (input.callbackUrl) payload.callbackUrl = input.callbackUrl;
  const result = await wiroPost<WiroSubmitResponse>(
    WIRO_RUN_ENDPOINT,
    payload,
    credentials,
    fetcher,
  );
  if (!result.taskid || !result.socketaccesstoken)
    throw new Error("wiro_submit_missing_task");
  return {
    taskid: String(result.taskid),
    socketaccesstoken: String(result.socketaccesstoken),
  };
}

export async function getWiroTaskDetail(
  taskid: string,
  credentials: WiroCredentials,
  fetcher: typeof fetch = fetch,
): Promise<WiroTask> {
  if (!taskid) throw new Error("wiro_missing_taskid");
  const result = await wiroPost<WiroDetailResponse>(
    WIRO_DETAIL_ENDPOINT,
    { taskid },
    credentials,
    fetcher,
  );
  const task = result.tasklist?.[0];
  if (!task) throw new Error("wiro_detail_missing_task");
  return task;
}

export function wiroTaskState(status: string) {
  if (status === WIRO_COMPLETED_STATUS) return "completed" as const;
  if (status === WIRO_CANCELLED_STATUS) return "cancelled" as const;
  if (runningStatuses.has(status)) return "running" as const;
  throw new Error("wiro_unknown_status");
}

export function wiroVideoOutput(task: WiroTask): WiroOutput {
  const output = task.outputs?.find(
    (item) =>
      /^video\//i.test(item.contenttype || "") &&
      /^https:\/\//i.test(item.url || ""),
  );
  if (!output) throw new Error("wiro_result_missing_video");
  return output;
}

export function wiroErrorCode(error: unknown, fallback: string) {
  const code = String(error).match(
    /\bwiro_(?:http_[1-5]\d{2}|api_[a-z0-9_]{1,80}|submit_missing_task|invalid_(?:prompt|duration|resolution|ratio|seed)|not_configured)\b/,
  )?.[0];
  return code || fallback;
}

export async function submitAndPollWiroTask(
  input: WiroRunInput,
  credentials: WiroCredentials,
  options: {
    fetcher?: typeof fetch;
    intervalMs?: number;
    maxAttempts?: number;
    sleep?: (milliseconds: number) => Promise<void>;
  } = {},
) {
  const fetcher = options.fetcher || fetch;
  const intervalMs = options.intervalMs ?? 15_000;
  const maxAttempts = options.maxAttempts ?? 80;
  const sleep =
    options.sleep ||
    ((milliseconds: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const submission = await submitWiroTask(input, credentials, fetcher);
  for (let attempt = 0; attempt <= maxAttempts; attempt++) {
    const task = await getWiroTaskDetail(
      submission.taskid,
      credentials,
      fetcher,
    );
    const state = wiroTaskState(task.status);
    if (state === "completed")
      return { submission, task, output: wiroVideoOutput(task) };
    if (state === "cancelled") throw new Error("wiro_task_cancelled");
    if (attempt === maxAttempts) break;
    await sleep(intervalMs);
  }
  throw new Error("wiro_poll_timeout");
}
