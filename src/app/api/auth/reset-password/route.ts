import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson, route } from "@/lib/auth/guard";
import { resetPasswordWithToken } from "@/lib/services/otp";

const schema = z.object({
  resetToken: z.string().min(1, "Reset token is required"),
  password: z.string().min(1, "Password is required").max(128),
});

export const POST = route(
  async ({ req }) => {
    const body = await readJson(req, schema);
    await resetPasswordWithToken(body.resetToken, body.password);
    return NextResponse.json({ ok: true, message: "Password updated successfully." });
  },
  { auth: false, rate: { name: "reset-password", limit: 5, windowMs: 15 * 60_000 } },
);
