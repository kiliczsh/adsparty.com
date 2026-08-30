import type { Server } from "node:http";

export function validBearer(
  header: string | undefined,
  secret: string | undefined,
): boolean;
export function validSource(value: unknown): boolean;
export const server: Server;
