import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson, route } from "@/lib/auth/guard";
import { verifyPasswordResetOtp } from "@/lib/services/otp";

const schema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  otp: z.string().trim().length(6, "Verification code must be 6 digits"),
});

export const POST = route(
  async ({ req }) => {
    const body = await readJson(req, schema);
    const { resetToken } = await verifyPasswordResetOtp(body.email, body.otp);
    return NextResponse.json({ ok: true, resetToken });
  },
  { auth: false, rate: { name: "verify-otp", limit: 5, windowMs: 15 * 60_000 } },
);
