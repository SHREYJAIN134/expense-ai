import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, readJson, route } from "@/lib/auth/guard";
import { verifyPassword } from "@/lib/auth/password";
import { clientIp, rateLimit, resetRateLimit } from "@/lib/auth/ratelimit";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { getUserByEmail } from "@/lib/services/users";

const schema = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) });

export const POST = route(
  async ({ req }) => {
    const body = await readJson(req, schema);
    const ip = clientIp(req.headers);
    // Per-account+IP throttle to slow password guessing (in addition to the per-IP limit below).
    const key = `login-acct:${ip}:${body.email}`;
    const r = rateLimit(key, 5, 15 * 60_000);
    if (!r.allowed) throw new ApiError(429, "RATE_LIMITED", `Too many sign-in attempts. Try again in ${Math.ceil(r.retryAfterSec / 60)} minute(s).`, { retryAfterSec: r.retryAfterSec });

    const user = getUserByEmail(body.email);
    const ok = await verifyPassword(body.password, user?.password_hash ?? null);
    if (!user || !ok) throw new ApiError(401, "INVALID_CREDENTIALS", "Invalid email or password.");

    resetRateLimit(key);
    const { token, expires } = createSession(user.id, req.headers.get("user-agent"));
    await setSessionCookie(token, expires);
    return NextResponse.json({ user: { id: user.id, email: user.email, name: user.name } });
  },
  { auth: false, rate: { name: "login-ip", limit: 30, windowMs: 15 * 60_000 } },
);
