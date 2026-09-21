import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson, route } from "@/lib/auth/guard";
import { requestPasswordResetOtp } from "@/lib/services/otp";

const schema = z.object({
  email: z.string().trim().toLowerCase().email("Invalid email address").max(200),
});

export const POST = route(
  async ({ req }) => {
    const body = await readJson(req, schema);
    await requestPasswordResetOtp(body.email);
    return NextResponse.json({
      ok: true,
      message: "If an account exists for this email address, a verification code has been sent.",
    });
  },
  { auth: false, rate: { name: "forgot-password", limit: 3, windowMs: 15 * 60_000 } },
);
