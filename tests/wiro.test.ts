import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  WIRO_DETAIL_ENDPOINT,
  WIRO_RUN_ENDPOINT,
  getWiroTaskDetail,
  submitAndPollWiroTask,
  submitWiroTask,
  wiroErrorCode,
  wiroGenerationSeed,
  wiroLanguageLockedPrompt,
  wiroSignature,
  wiroTaskState,
  wiroVideoOutput,
  type WiroRunInput,
} from "../src/wiro";

const credentials = { apiKey: "project-key", apiSecret: "project-secret" };
const input: WiroRunInput = {
  prompt: 'A host says, "Welcome."',
  duration: "5",
  resolution: "480P",
  ratio: "16:9",
  seed: 1000,
};

const response = (body: unknown) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
type RecordedFetchCall = [
  string,
  { method: string; headers: Record<string, string>; body: FormData },
];
const formValues = (form: FormData, names: string[]) =>
  Object.fromEntries(names.map((name) => [name, form.get(name)]));

describe("wiro authentication", () => {
  it("signs API secret plus nonce with the API key using HMAC-SHA256", async () => {
    const expected = createHmac("sha256", "project-key")
      .update("project-secret123")
      .digest("hex");
    expect(await wiroSignature("project-key", "project-secret", "123")).toBe(
      expected,
    );
  });
});

describe("wiro spoken-language policy", () => {
  it("allows only Turkish and English speech while keeping directions silent", () => {
    const prompt = wiroLanguageLockedPrompt(
      'A woman says, "Bu akşam çıkalım."',
    );
    expect(prompt).toContain("Turkish (tr-TR)");
    expect(prompt).toContain("AUDIO MODE — EXACT TURKISH DIALOGUE");
    expect(prompt).toContain("[SILENT PRODUCTION BRIEF]");
    expect(prompt).toContain('"Bu akşam çıkalım."');
    expect(prompt).toContain("must never be recited");
    expect(prompt).toContain("Do not add narration");
  });

  it("uses a short Turkish-only speech mode when Turkish is explicitly requested", () => {
    const prompt = wiroLanguageLockedPrompt(
      "İstanbul Aksaray tanıtım videosu Türkçe",
    );
    expect(prompt).toContain("AUDIO MODE — TURKISH SPEECH ONLY");
    expect(prompt).toContain("at most eight words");
    expect(prompt).toContain("natural Istanbul pronunciation");
    expect(prompt).toContain("use non-vocal ambience instead");
  });

  it("forbids invented voices when the scene has no quoted dialogue", () => {
    const prompt = wiroLanguageLockedPrompt("Fire in the hole!!! Goal");
    expect(prompt).toContain("AUDIO MODE — NO SPEECH");
    expect(prompt).toContain("environmental ambience and sound effects only");
    expect(prompt).toContain("No human voice, intelligible words");
  });
});

describe("wiro generation seed", () => {
  it("derives a stable but job-specific seed in per-job mode", () => {
    const first = wiroGenerationSeed("per-job", "job-one");
    expect(first).toBe(wiroGenerationSeed("per-job", "job-one"));
    expect(first).not.toBe(wiroGenerationSeed("per-job", "job-two"));
    expect(first).toBeGreaterThan(0);
  });

  it("retains an explicitly configured numeric seed", () => {
    expect(wiroGenerationSeed("1000", "job-one")).toBe(1000);
  });

  it("omits the seed when no seed mode is configured", () => {
    expect(wiroGenerationSeed(undefined, "job-one")).toBeUndefined();
    expect(wiroGenerationSeed("none", "job-one")).toBeUndefined();
  });
});

describe("wiro error hygiene", () => {
  it("retains safe provider error classes without exposing response bodies", () => {
    expect(wiroErrorCode(new Error("wiro_http_401"), "failed")).toBe(
      "wiro_http_401",
    );
    expect(wiroErrorCode(new Error("secret response body"), "failed")).toBe(
      "failed",
    );
  });

  it("normalizes a provider API error without retaining punctuation", async () => {
    const fetcher = vi.fn(() =>
      response({ result: false, errors: ["Invalid project or coupon!"] }),
    );
    await expect(
      submitWiroTask(input, credentials, fetcher as typeof fetch),
    ).rejects.toThrow("wiro_api_invalid_project_or_coupon");
  });
});

describe("wiro task lifecycle", () => {
  it("submits the documented FastH3 payload", async () => {
    const fetcher = vi.fn(() =>
      response({
        errors: [],
        taskid: "2221",
        socketaccesstoken: "socket-token",
        result: true,
      }),
    );
    await expect(
      submitWiroTask(input, credentials, fetcher as typeof fetch),
    ).resolves.toEqual({ taskid: "2221", socketaccesstoken: "socket-token" });
    const [url, init] = (
      fetcher.mock.calls as unknown as RecordedFetchCall[]
    )[0]!;
    expect(url).toBe(WIRO_RUN_ENDPOINT);
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBeUndefined();
    expect(init.headers["x-api-key"]).toBe("project-key");
    expect(init.headers["x-nonce"]).toMatch(/^\d+$/);
    expect(init.headers["x-signature"]).toMatch(/^[a-f0-9]{64}$/);
    expect(
      formValues(init.body, [
        "prompt",
        "duration",
        "resolution",
        "ratio",
        "seed",
      ]),
    ).toEqual({
      ...input,
      prompt: wiroLanguageLockedPrompt(input.prompt),
      seed: String(input.seed),
    });
  });

  it("does not send a seed field when the input omits it", async () => {
    const fetcher = vi.fn(() =>
      response({
        errors: [],
        taskid: "2222",
        socketaccesstoken: "socket-token-2",
        result: true,
      }),
    );
    const { seed: _seed, ...seedlessInput } = input;
    await submitWiroTask(seedlessInput, credentials, fetcher as typeof fetch);
    const [, init] = (fetcher.mock.calls as unknown as RecordedFetchCall[])[0]!;
    expect(init.body.has("seed")).toBe(false);
  });

  it("polls by task id until the documented completed status", async () => {
    const fetcher = vi
      .fn()
      .mockImplementationOnce(() =>
        response({
          errors: [],
          taskid: "2221",
          socketaccesstoken: "socket-token",
          result: true,
        }),
      )
      .mockImplementationOnce(() =>
        response({
          total: "1",
          errors: [],
          tasklist: [{ id: "2221", status: "task_output", outputs: [] }],
          result: true,
        }),
      )
      .mockImplementationOnce(() =>
        response({
          total: "1",
          errors: [],
          tasklist: [
            {
              id: "2221",
              status: "task_postprocess_end",
              outputs: [
                {
                  id: "video-1",
                  name: "0.mp4",
                  contenttype: "video/mp4",
                  size: "100",
                  url: "https://cdn1.wiro.ai/output/0.mp4",
                },
              ],
            },
          ],
          result: true,
        }),
      );
    const sleep = vi.fn(() => Promise.resolve());
    const result = await submitAndPollWiroTask(input, credentials, {
      fetcher: fetcher as typeof fetch,
      intervalMs: 15_000,
      sleep,
    });
    expect(result.output.url).toBe("https://cdn1.wiro.ai/output/0.mp4");
    expect(sleep).toHaveBeenCalledWith(15_000);
    expect(fetcher.mock.calls[1][0]).toBe(WIRO_DETAIL_ENDPOINT);
    expect(formValues(fetcher.mock.calls[1][1].body, ["taskid"])).toEqual({
      taskid: "2221",
    });
  });

  it("accepts only documented statuses and video outputs", async () => {
    expect(wiroTaskState("task_queue")).toBe("running");
    expect(wiroTaskState("task_postprocess_start")).toBe("running");
    expect(wiroTaskState("task_postprocess_end")).toBe("completed");
    expect(wiroTaskState("task_cancel")).toBe("cancelled");
    expect(() => wiroTaskState("invented_status")).toThrow(
      "wiro_unknown_status",
    );
    expect(() =>
      wiroVideoOutput({
        id: "1",
        socketaccesstoken: "token",
        status: "task_postprocess_end",
        outputs: [
          {
            id: "image",
            name: "0.png",
            contenttype: "image/png",
            size: "10",
            url: "https://cdn1.wiro.ai/output/0.png",
          },
        ],
      }),
    ).toThrow("wiro_result_missing_video");
  });

  it("gets task detail with the documented taskid field", async () => {
    const fetcher = vi.fn(() =>
      response({
        total: "1",
        errors: [],
        tasklist: [
          {
            id: "2221",
            socketaccesstoken: "socket-token",
            status: "task_start",
            outputs: [],
          },
        ],
        result: true,
      }),
    );
    await expect(
      getWiroTaskDetail("2221", credentials, fetcher as typeof fetch),
    ).resolves.toMatchObject({ id: "2221", status: "task_start" });
    const calls = fetcher.mock.calls as unknown as RecordedFetchCall[];
    expect(formValues(calls[0]![1].body, ["taskid"])).toEqual({
      taskid: "2221",
    });
  });
});
