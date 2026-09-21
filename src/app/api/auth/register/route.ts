import { NextResponse } from "next/server";
import { z } from "zod";
import { ApiError, readJson, route } from "@/lib/auth/guard";
import { checkPasswordStrength } from "@/lib/auth/password";
import { createSession, setSessionCookie } from "@/lib/auth/session";
import { countUsers, createUser, getUserByEmail } from "@/lib/services/users";

const schema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().max(200),
});

/** Single-user app: sign-up only works while no account exists, unless ALLOW_REGISTRATION=true. */
export const POST = route(
  async ({ req }) => {
    if (countUsers() > 0 && process.env.ALLOW_REGISTRATION !== "true") {
      throw new ApiError(403, "REGISTRATION_CLOSED", "An account already exists. Sign in instead.");
    }
    const body = await readJson(req, schema);
    const pw = checkPasswordStrength(body.password);
    if (!pw.ok) throw new ApiError(400, "WEAK_PASSWORD", pw.message!);
    if (getUserByEmail(body.email)) throw new ApiError(409, "EMAIL_TAKEN", "An account with this email already exists.");
    const user = await createUser(body);
    const { token, expires } = createSession(user.id, req.headers.get("user-agent"));
    await setSessionCookie(token, expires);
    return NextResponse.json({ user });
  },
  { auth: false, rate: { name: "register", limit: 5, windowMs: 60 * 60_000 } },
);
