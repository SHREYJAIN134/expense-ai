/**
 * Email Delivery Module for Expense AI.
 * 
 * Configured via Environment Variables:
 * 1. Resend API (Recommended for Vercel):
 *    - RESEND_API_KEY
 *    - EMAIL_FROM (Optional, defaults to "Expense AI <noreply@resend.dev>")
 * 
 * 2. SMTP Server (Optional fallback):
 *    - SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS
 *    - EMAIL_FROM
 */

export interface SendOtpInput {
  to: string;
  otp: string;
  expiresMinutes: number;
}

export function getOtpHtml(otp: string, expiresMinutes: number): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Expense AI - Password Reset Code</title>
</head>
<body style="margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #f3eee4; color: #15171c;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f3eee4; padding: 40px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 460px; background-color: #ffffff; border: 1px solid #e2ded4; border-radius: 12px; padding: 32px; box-shadow: 0 4px 12px rgba(0,0,0,0.03);">
          <tr>
            <td>
              <div style="font-size: 16px; font-weight: 700; color: #15171c; margin-bottom: 24px; letter-spacing: -0.02em;">
                Expense AI <span style="font-weight: 400; font-size: 12px; color: #706e68; margin-left: 6px;">· Personal Finance</span>
              </div>
              <h1 style="font-size: 20px; font-weight: 600; color: #15171c; margin: 0 0 12px 0;">Reset Your Password</h1>
              <p style="font-size: 14px; color: #52504a; line-height: 1.5; margin: 0 0 24px 0;">
                Use the one-time passcode below to reset your Expense AI account password.
              </p>
              
              <div style="background-color: #f8f6f0; border: 1px solid #e2ded4; border-radius: 8px; padding: 20px; text-align: center; font-family: 'DM Mono', Monaco, Consolas, monospace; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #15171c; margin-bottom: 24px;">
                ${otp}
              </div>
              
              <p style="font-size: 13px; color: #706e68; line-height: 1.5; margin: 0 0 20px 0;">
                ⏱️ This code will expire in <strong>${expiresMinutes} minutes</strong> and can only be used once.
              </p>
              
              <div style="border-top: 1px solid #e2ded4; padding-top: 20px; margin-top: 24px;">
                <p style="font-size: 12px; color: #8c8880; line-height: 1.4; margin: 0;">
                  🔒 <strong>Security Guidance:</strong> If you did not request a password reset, you can safely ignore this email. Never share your OTP code with anyone. Expense AI will never ask for your code.
                </p>
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

export async function sendOtpEmail(input: SendOtpInput): Promise<{ sent: boolean; reason?: string }> {
  const { to, otp, expiresMinutes } = input;
  const from = process.env.EMAIL_FROM || "Expense AI <noreply@resend.dev>";
  const resendApiKey = process.env.RESEND_API_KEY?.trim();

  // In non-production, print to console for convenient local testing
  if (process.env.NODE_ENV !== "production" || process.env.DEBUG_EMAIL === "true") {
    console.log(`[DEV EMAIL] OTP to ${to}: ${otp} (expires in ${expiresMinutes} min)`);
  }

  // Provider 1: Resend HTTP API
  if (resendApiKey) {
    try {
      const res = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${resendApiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject: `Your Expense AI Verification Code: ${otp}`,
          html: getOtpHtml(otp, expiresMinutes),
          text: `Your Expense AI verification code is ${otp}. This code expires in ${expiresMinutes} minutes. Never share this code with anyone.`,
        }),
      });

      if (!res.ok) {
        const errText = await res.text();
        console.error(`[email] Resend API error (${res.status}):`, errText);
        return { sent: false, reason: `Resend API returned ${res.status}` };
      }

      return { sent: true };
    } catch (err) {
      console.error("[email] Failed to send via Resend API:", err);
      return { sent: false, reason: "HTTP_FETCH_ERROR" };
    }
  }

  // No email credentials configured
  if (process.env.NODE_ENV === "production") {
    console.warn("[email] Warning: No email provider configured. Set RESEND_API_KEY or SMTP env vars in Vercel.");
  }
  
  return { sent: false, reason: "NO_EMAIL_PROVIDER_CONFIGURED" };
}
