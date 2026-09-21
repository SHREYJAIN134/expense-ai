import crypto from "node:crypto";
import { cookies } from "next/headers";
import { getDb, uid } from "../db/client";
import { getAuthSecret } from "./secret";
import { getUserById, ensureUserRecord } from "../services/users";

export const SESSION_COOKIE = "eai_session";
const RENEW_AFTER_MS = 60 * 60 * 1000;

export interface SessionUser {
  id: string;
  email: string;
  name: string;
}

interface TokenPayload {
  u: string;
  e: string;
  n: string;
  x: number;
}

function ttlMs(): number {
  const days = Number(process.env.SESSION_TTL_DAYS ?? 14);
  return (Number.isFinite(days) && days > 0 ? days : 14) * 86_400_000;
}

/** Only this keyed hash is stored, so a leaked database cannot be replayed as cookies. */
export function hashToken(token: string): string {
  return crypto.createHmac("sha256", getAuthSecret()).update(token).digest("hex");
}

function signPayload(payloadB64: string): string {
  return crypto.createHmac("sha256", getAuthSecret()).update(payloadB64).digest("base64url");
}

const sqlTime = (ms: number) => new Date(ms).toISOString().replace("T", " ").slice(0, 19);

export function createSession(
  userArg: string | { id: string; email: string; name: string },
  userAgent?: string | null
): { token: string; expires: Date } {
  let userId: string;
  let email = "";
  let name = "";

  if (typeof userArg === "string") {
    userId = userArg;
    const dbUser = getUserById(userArg);
    if (dbUser) {
      email = dbUser.email;
      name = dbUser.name;
    }
  } else {
    userId = userArg.id;
    email = userArg.email;
    name = userArg.name;
  }

  const expires = new Date(Date.now() + ttlMs());
  const expMs = expires.getTime();

  const payloadObj: TokenPayload = { u: userId, e: email, n: name, x: expMs };
  const payloadB64 = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
  const sig = signPayload(payloadB64);
  const token = `${payloadB64}.${sig}`;

  // Opportunistic local database recording (if single-instance / local DB)
  try {
    getDb()
      .prepare("INSERT OR REPLACE INTO sessions (id, user_id, expires_at, user_agent) VALUES (?, ?, ?, ?)")
      .run(hashToken(token), userId, sqlTime(expMs), userAgent?.slice(0, 200) ?? null);
    getDb().prepare("DELETE FROM sessions WHERE expires_at < ?").run(sqlTime(Date.now()));
  } catch {
    /* stateless fallback for multi-instance serverless environments */
  }

  return { token, expires };
}

export function validateSessionToken(token: string | undefined | null): SessionUser | null {
  if (!token || typeof token !== "string" || token.length < 15) return null;

  // 1. Primary: Validate HMAC-signed stateless session token (works across all serverless lambdas)
  const parts = token.split(".");
  if (parts.length === 2) {
    const [payloadB64, sig] = parts;
    const expectedSig = signPayload(payloadB64);

    let validSig = false;
    try {
      const bSig = Buffer.from(sig);
      const bExp = Buffer.from(expectedSig);
      if (bSig.length === bExp.length) {
        validSig = crypto.timingSafeEqual(bSig, bExp);
      }
    } catch {
      validSig = false;
    }

    if (validSig) {
      try {
        const payload: TokenPayload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
        if (payload.u && payload.x && payload.x >= Date.now()) {
          // Check DB row if present to support session revocation / DB expiration tests
          try {
            const db = getDb();
            const id = hashToken(token);
            const row = db.prepare("SELECT expires_at FROM sessions WHERE id = ?").get(id) as { expires_at: string } | undefined;
            if (row) {
              const rowExp = new Date(row.expires_at.replace(" ", "T") + "Z").getTime();
              if (rowExp < Date.now()) {
                db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
                return null;
              }
            }
          } catch {
            /* ignore DB lookup failure in serverless multi-instance */
          }
          if (payload.e && payload.n) {
            ensureUserRecord(payload.u, payload.e, payload.n);
          }
          return { id: payload.u, email: payload.e || "", name: payload.n || "" };
        }
      } catch {
        /* fallback to DB lookup below */
      }
    }
  }

  // 2. Secondary fallback: Database lookup for legacy un-signed tokens
  try {
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
  } catch {
    return null;
  }
}

export function destroySession(token: string | undefined | null) {
  if (!token) return;
  const id = hashToken(token);
  try {
    const db = getDb();
    const row = db.prepare("SELECT user_id FROM sessions WHERE id = ?").get(id) as { user_id: string } | undefined;
    const uid = row?.user_id || "revoked";
    db.prepare("INSERT OR REPLACE INTO sessions (id, user_id, expires_at) VALUES (?, ?, '2000-01-01 00:00:00')").run(id, uid);
  } catch {
    /* ignore */
  }
}

export function destroyAllSessions(userId: string, exceptToken?: string | null) {
  const keep = exceptToken ? hashToken(exceptToken) : "";
  try {
    getDb().prepare("UPDATE sessions SET expires_at = '2000-01-01 00:00:00' WHERE user_id = ? AND id != ?").run(userId, keep);
  } catch {
    /* ignore */
  }
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
