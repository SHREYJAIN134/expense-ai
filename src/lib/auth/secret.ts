import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveDataLocation } from "../db/paths";

let cached: string | null = null;

/**
 * AUTH_SECRET keys the session-token HMAC. In production it MUST come from the
 * environment. In development, a random secret is generated once and kept in
 * <data dir>/.auth-secret (see db/paths.ts) so you can run without any setup.
 */
export function getAuthSecret(): string {
  if (cached) return cached;
  const env = process.env.AUTH_SECRET?.trim();
  if (env) {
    if (env.length < 32) throw new Error("AUTH_SECRET must be at least 32 characters.");
    cached = env;
    return cached;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("AUTH_SECRET is required in production. See .env.example.");
  }
  const loc = resolveDataLocation();
  // Kept beside the database (outside any cloud-synced folder by default).
  const file = path.join(loc.dir === ":memory:" ? path.resolve(process.cwd(), "data") : loc.dir, ".auth-secret");
  try {
    cached = fs.readFileSync(file, "utf8").trim();
    if (cached.length >= 32) return cached;
  } catch {
    /* generate below */
  }
  cached = crypto.randomBytes(48).toString("base64url");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, cached, { mode: 0o600 });
  } catch {
    /* in-memory only: sessions reset on restart */
  }
  return cached;
}
