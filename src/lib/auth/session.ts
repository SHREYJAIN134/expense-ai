import crypto from "node:crypto";
import { cookies } from "next/headers";
import { getDb, uid } from "../db/client";
import { getAuthSecret } from "./secret";

export const SESSION_COOKIE = "eai_session";
const RENEW_AFTER_MS = 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

function ttlMs(): number {
  const days = Number(process.env.SESSION_TTL_DAYS ?? 14);
  return (Number.isFinite(days) && days > 0 ? days : 14) * 86_400_000;
}

/** Only this keyed hash is stored, so a leaked database cannot be replayed as cookies. */
export function hashToken(token: string): string {
  return crypto.createHmac("sha256", getAuthSecret()).update(token).digest("hex");
}

const sqlTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

export function createSession(userId: string, userAgent?: string | null): { token: string; expires: Date } {
  const token = crypto.randomBytes(32).toString("base64url");
  const expires = new Date(Date.now() + ttlMs());
  getDb()
    .prepare("INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)")
    .run(hashToken(token), userId, sqlTime(expires.getTime()), userAgent?.slice(0, 200) ?? null);
  // opportunistic cleanup
  getDb().prepare("DELETE FROM sessions WHERE expires_at < ?").run(sqlTime(Date.now()));
  return { token, expires };
}

export function validateSessionToken(token: string | undefined | null): SessionUser | null {
  if (!token || token.length < 20 || token.length > 200) return null;
  const db = getDb();
  const id = hashToken(token);
  const row = db
    .prepare(
      `SELECT s.id, s.expires_at, s.last_seen_at, u.id AS uid, u.email, u.name
       FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ?`,
    )
    .get(id) as { id: string; expires_at: string; last_seen_at: string; uid: string; email: string; name: string } | undefined;
  if (!row) return null;
  const now = Date.now();
  if (new Date(row.expires_at.replace(" ", "T") + "Z").getTime() < now) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
    return null;
  }
  if (now - new Date(row.last_seen_at.replace(" ", "T") + "Z").getTime() > RENEW_AFTER_MS) {
    db.prepare("UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?").run(sqlTime(now), sqlTime(now + ttlMs()), id);
  }
  return { id: row.uid, email: row.email, name: row.name };
}

export function destroySession(token: string | undefined | null) {
  if (!token) return;
  getDb().prepare("DELETE FROM sessions WHERE id = ?").run(hashToken(token));
}

export function destroyAllSessions(userId: string, exceptToken?: string | null) {
  const keep = exceptToken ? hashToken(exceptToken) : "";
  getDb().prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(userId, keep);
}

export async function setSessionCookie(token: string, expires: Date) {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production" && process.env.COOKIE_SECURE !== "false",
    path: "/",
    expires,
  });
}

export async function clearSessionCookie() {
  const jar = await cookies();
  jar.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
}

/** Current user for Server Components / route handlers. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const jar = await cookies();
  return validateSessionToken(jar.get(SESSION_COOKIE)?.value);
}

export async function getSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE)?.value;
}

export const newId = uid;
