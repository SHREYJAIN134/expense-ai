import crypto from "node:crypto";
import { getDb, uid } from "../db/client";
import { getAuthSecret } from "../auth/secret";
import { checkPasswordStrength, hashPassword } from "../auth/password";
import { getUserByEmail } from "./users";
import { sendOtpEmail } from "../email/sender";
import { ApiError } from "../auth/guard";

const OTP_TTL_MINUTES = 10;
const MAX_OTP_ATTEMPTS = 5;

function hashToken(val: string): string {
  return crypto.createHmac("sha256", getAuthSecret()).update(val).digest("hex");
}

function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export async function requestPasswordResetOtp(email: string): Promise<{ ok: boolean }> {
  const cleanEmail = email.trim().toLowerCase();
  const user = getUserByEmail(cleanEmail);

  // Email enumeration protection: if account does not exist, return generic success immediately.
  if (!user) {
    return { ok: true };
  }

  const db = getDb();
  
  // Expire/invalidate all previous unused OTPs for this user
  db.prepare("UPDATE password_reset_otps SET used = 1 WHERE user_id = ? AND used = 0").run(user.id);

  // Generate 6-digit cryptographically secure OTP
  const otp = crypto.randomInt(100000, 1000000).toString();
  const otpHash = hashToken(otp);

  const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000).toISOString();
  const id = uid();

  db.prepare(
    `INSERT INTO password_reset_otps (id, user_id, email, otp_hash, expires_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(id, user.id, cleanEmail, otpHash, expiresAt);

  // Send OTP via configured email transport
  await sendOtpEmail({ to: user.email, otp, expiresMinutes: OTP_TTL_MINUTES });

  return { ok: true };
}

export async function verifyPasswordResetOtp(email: string, otp: string): Promise<{ resetToken: string }> {
  const cleanEmail = email.trim().toLowerCase();
  const cleanOtp = otp.trim();
  const user = getUserByEmail(cleanEmail);

  if (!user) {
    throw new ApiError(400, "INVALID_OTP", "Invalid or expired verification code.");
  }

  const db = getDb();
  const record = db
    .prepare(
      `SELECT * FROM password_reset_otps 
       WHERE user_id = ? AND used = 0 AND expires_at > datetime('now') 
       ORDER BY created_at DESC LIMIT 1`
    )
    .get(user.id) as
    | { id: string; user_id: string; otp_hash: string; reset_token_hash: string | null; attempts: number }
    | undefined;

  if (!record) {
    throw new ApiError(400, "INVALID_OTP", "Invalid or expired verification code.");
  }

  if (record.attempts >= MAX_OTP_ATTEMPTS) {
    db.prepare("UPDATE password_reset_otps SET used = 1 WHERE id = ?").run(record.id);
    throw new ApiError(400, "OTP_EXHAUSTED", "Too many incorrect attempts. Please request a new verification code.");
  }

  if (record.reset_token_hash) {
    throw new ApiError(400, "INVALID_OTP", "Invalid or expired verification code.");
  }

  const inputHash = hashToken(cleanOtp);
  if (!safeCompare(inputHash, record.otp_hash)) {
    db.prepare("UPDATE password_reset_otps SET attempts = attempts + 1 WHERE id = ?").run(record.id);
    throw new ApiError(400, "INVALID_OTP", "Invalid or expired verification code.");
  }

  // OTP verified successfully: issue a single-use short-lived reset token
  const resetToken = crypto.randomBytes(32).toString("hex");
  const resetTokenHash = hashToken(resetToken);

  db.prepare("UPDATE password_reset_otps SET reset_token_hash = ? WHERE id = ?").run(resetTokenHash, record.id);

  return { resetToken };
}

export async function resetPasswordWithToken(resetToken: string, newPassword: string): Promise<{ ok: boolean }> {
  const check = checkPasswordStrength(newPassword);
  if (!check.ok) {
    throw new ApiError(400, "WEAK_PASSWORD", check.message || "Invalid password.");
  }

  const db = getDb();
  const resetTokenHash = hashToken(resetToken);

  const record = db
    .prepare(
      `SELECT * FROM password_reset_otps 
       WHERE reset_token_hash = ? AND used = 0 AND expires_at > datetime('now')`
    )
    .get(resetTokenHash) as { id: string; user_id: string } | undefined;

  if (!record) {
    throw new ApiError(400, "INVALID_TOKEN", "Invalid or expired reset session. Please request a new verification code.");
  }

  // Consume token and update user password
  const newHash = await hashPassword(newPassword);
  
  db.transaction(() => {
    db.prepare("UPDATE password_reset_otps SET used = 1 WHERE id = ?").run(record.id);
    db.prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(newHash, record.user_id);
    // Invalidate all active user sessions for safety
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(record.user_id);
  })();

  return { ok: true };
}
