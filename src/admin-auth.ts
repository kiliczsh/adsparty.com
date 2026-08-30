import { constantTimeEqual } from "./core";

export const ADMIN_SESSION_COOKIE = "adsparty_admin";
export const ADMIN_SESSION_SECONDS = 12 * 60 * 60;
// Cloudflare Workers currently caps PBKDF2 at 100,000 iterations.
export const ADMIN_PASSWORD_ITERATIONS = 100_000;

const encoder = new TextEncoder();
const hex = (bytes: ArrayBuffer | Uint8Array) =>
  [...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export function validAdminUsername(value: unknown) {
  return /^[A-Za-z0-9_-]{3,32}$/.test(String(value || ""));
}

export function validAdminPassword(value: unknown) {
  const password = String(value || "");
  return password.length >= 12 && password.length <= 128;
}

export function randomHex(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return hex(value);
}

export async function passwordHash(
  password: string,
  salt: string,
  iterations = ADMIN_PASSWORD_ITERATIONS,
) {
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"],
  );
  return hex(
    await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        hash: "SHA-256",
        salt: encoder.encode(salt),
        iterations,
      },
      material,
      256,
    ),
  );
}

export async function newPasswordRecord(password: string) {
  if (!validAdminPassword(password)) throw new Error("invalid_admin_password");
  const salt = randomHex(16);
  return {
    salt,
    hash: await passwordHash(password, salt),
    iterations: ADMIN_PASSWORD_ITERATIONS,
  };
}

export async function verifyPassword(
  password: string,
  salt: string,
  expected: string,
  iterations: number,
) {
  const actual = await passwordHash(password, salt, iterations);
  return constantTimeEqual(actual, expected);
}

export async function sessionHash(token: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(token)));
}

export function adminSessionCookie(token: string) {
  return `${ADMIN_SESSION_COOKIE}=${token}; Path=/; Max-Age=${ADMIN_SESSION_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearAdminSessionCookie() {
  return `${ADMIN_SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export function adminSessionToken(cookie: string | null) {
  return (
    cookie?.match(
      new RegExp(`(?:^|; )${ADMIN_SESSION_COOKIE}=([a-f0-9]{64})(?:;|$)`),
    )?.[1] || null
  );
}
