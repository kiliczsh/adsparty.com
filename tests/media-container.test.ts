import { describe, expect, it } from "vitest";

process.env.NODE_ENV = "test";
const { validBearer, validSource } =
  await import("../media-container/server.mjs");

describe("media packager boundary", () => {
  it("requires an exact bearer secret", () => {
    expect(validBearer("Bearer correct-token", "correct-token")).toBe(true);
    expect(validBearer("Bearer wrong-token", "correct-token")).toBe(false);
    expect(validBearer(undefined, "correct-token")).toBe(false);
    expect(validBearer("Bearer correct-token", undefined)).toBe(false);
  });
  it("accepts only HTTPS fal media sources", () => {
    expect(validSource("https://v3b.fal.media/files/video.mp4")).toBe(true);
    expect(validSource("https://fal.media/video.mp4")).toBe(false);
    expect(validSource("http://v3b.fal.media/video.mp4")).toBe(false);
    expect(validSource("https://fal.media.attacker.example/video.mp4")).toBe(
      false,
    );
    expect(validSource("https://127.0.0.1/video.mp4")).toBe(false);
  });
});
