import { describe, expect, it } from "vitest";
import {
  ADMIN_PASSWORD_ITERATIONS,
  adminSessionCookie,
  adminSessionToken,
  clearAdminSessionCookie,
  newPasswordRecord,
  sessionHash,
  validAdminPassword,
  validAdminUsername,
  verifyPassword,
} from "../src/admin-auth";

describe("admin authentication primitives", () => {
  it("validates admin usernames and strong passwords", () => {
    expect(validAdminUsername("operator_1")).toBe(true);
    expect(validAdminUsername("x")).toBe(false);
    expect(validAdminUsername("bad user")).toBe(false);
    expect(validAdminPassword("correct-horse-42")).toBe(true);
    expect(validAdminPassword("short")).toBe(false);
  });

  it("hashes and verifies passwords without storing plaintext", async () => {
    const record = await newPasswordRecord("correct-horse-42");
    expect(record.iterations).toBe(ADMIN_PASSWORD_ITERATIONS);
    expect(record.hash).not.toContain("correct-horse-42");
    expect(
      await verifyPassword(
        "correct-horse-42",
        record.salt,
        record.hash,
        record.iterations,
      ),
    ).toBe(true);
    expect(
      await verifyPassword(
        "wrong-password",
        record.salt,
        record.hash,
        record.iterations,
      ),
    ).toBe(false);
  });

  it("uses opaque HttpOnly strict cookies and hashed session ids", async () => {
    const token = "a".repeat(64);
    const cookie = adminSessionCookie(token);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Strict");
    expect(adminSessionToken(cookie)).toBe(token);
    expect(await sessionHash(token)).not.toBe(token);
    expect(clearAdminSessionCookie()).toContain("Max-Age=0");
  });
});
