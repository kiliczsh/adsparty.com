import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  WIRO_DETAIL_ENDPOINT,
  WIRO_RUN_ENDPOINT,
  getWiroTaskDetail,
  submitAndPollWiroTask,
  submitWiroTask,
  wiroErrorCode,
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
    ).toEqual({ ...input, seed: String(input.seed) });
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
