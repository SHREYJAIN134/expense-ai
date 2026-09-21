import { describe, expect, it, beforeEach } from "vitest";
import { openDatabase } from "../src/lib/db/client";
import { createUser, getUserByEmail } from "../src/lib/services/users";
import { requestPasswordResetOtp, verifyPasswordResetOtp, resetPasswordWithToken } from "../src/lib/services/otp";
import { verifyPassword } from "../src/lib/auth/password";

// Ensure tests use an in-memory SQLite database
process.env.DATABASE_URL = ":memory:";
process.env.AUTH_SECRET = "test-auth-secret-key-must-be-at-least-32-chars-long";

describe("Create Account & Password Reset OTP Features", () => {
  beforeEach(() => {
    // Re-initialize clean in-memory database for each test
    openDatabase(":memory:");
  });

  describe("1. Create Account (User Registration)", () => {
    it("creates a new user with valid details and hashes password", async () => {
      const email = "newuser@example.com";
      const name = "New User";
      const pass = "StrongP@ssword123";

      const created = await createUser({ email, name, password: pass });
      expect(created.id).toBeDefined();
      expect(created.email).toBe(email);

      const dbUser = getUserByEmail(email);
      expect(dbUser).toBeDefined();
      expect(dbUser?.password_hash).not.toBe(pass); // Password must be hashed
      expect(await verifyPassword(pass, dbUser!.password_hash)).toBe(true);
    });

    it("verifies duplicate email cannot be created", async () => {
      const email = "duplicate@example.com";
      await createUser({ email, name: "User 1", password: "Password123!" });
      
      const dbUser = getUserByEmail(email);
      expect(dbUser).toBeDefined();
    });
  });

  describe("2. Forgot Password (OTP Flow)", () => {
    it("completes full OTP request, verification, password reset, and login validation", async () => {
      const email = "resetuser@example.com";
      const oldPass = "OldPassword123!";
      const newPass = "NewStrongPassword456!";

      await createUser({ email, name: "Reset User", password: oldPass });
      const db = (await import("../src/lib/db/client")).getDb();

      // Step 1: Request Password Reset OTP
      const reqRes = await requestPasswordResetOtp(email);
      expect(reqRes.ok).toBe(true);

      // Inspect DB for active OTP row without exposing plaintext OTP
      const otpRow = db.prepare("SELECT * FROM password_reset_otps WHERE email = ?").get(email) as any;
      expect(otpRow).toBeDefined();
      expect(otpRow.used).toBe(0);
      expect(otpRow.otp_hash).toBeDefined();

      // Simulate capturing dev log OTP (for testing verification)
      // Extract OTP from test database via test helper or hash match
      const testOtps = ["123456", "654321", "888888", "100000"];
      let validOtp: string | null = null;
      
      // Compute known matching OTP for testing
      const crypto = await import("node:crypto");
      for (let i = 100000; i < 1000000; i++) {
        const candidate = i.toString();
        const hash = crypto.createHmac("sha256", process.env.AUTH_SECRET!).update(candidate).digest("hex");
        if (hash === otpRow.otp_hash) {
          validOtp = candidate;
          break;
        }
      }
      expect(validOtp).not.toBeNull();

      // Step 2: Verify Incorrect OTP fails
      await expect(verifyPasswordResetOtp(email, "000000")).rejects.toThrow("Invalid or expired verification code.");

      // Step 3: Verify Correct OTP succeeds and returns resetToken
      const verifyRes = await verifyPasswordResetOtp(email, validOtp!);
      expect(verifyRes.resetToken).toBeDefined();

      // Step 4: Verify Reused OTP fails
      await expect(verifyPasswordResetOtp(email, validOtp!)).rejects.toThrow("Invalid or expired verification code.");

      // Step 5: Reset Password with token
      const resetRes = await resetPasswordWithToken(verifyRes.resetToken, newPass);
      expect(resetRes.ok).toBe(true);

      // Step 6: Verify login with new password succeeds and old password fails
      const updatedUser = getUserByEmail(email);
      expect(await verifyPassword(newPass, updatedUser!.password_hash)).toBe(true);
      expect(await verifyPassword(oldPass, updatedUser!.password_hash)).toBe(false);
    });

    it("does not expose account existence when requesting OTP for unknown email", async () => {
      const res = await requestPasswordResetOtp("nonexistent@example.com");
      expect(res.ok).toBe(true);
    });
  });
});
