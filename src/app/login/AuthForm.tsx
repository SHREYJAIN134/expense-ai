"use client";

import { Lock, LineChart, ShieldCheck, Sparkles, ArrowLeft, CheckCircle2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiClientError } from "@/lib/client/api";
import { Alert, Field } from "@/components/ui";

type AuthMode = "loading" | "login" | "register" | "forgot" | "verify_otp" | "new_password" | "reset_success";

export default function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<AuthMode>("loading");
  const [registrationAllowed, setRegistrationAllowed] = useState(true);

  // Form Fields
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [otp, setOtp] = useState("");
  const [resetToken, setResetToken] = useState("");

  // Status & Feedback State
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ hasUsers: boolean; registrationOpen: boolean }>("/api/auth/status")
      .then((s) => {
        setRegistrationAllowed(s.registrationOpen);
        setMode(s.hasUsers ? "login" : "register");
      })
      .catch(() => setMode("login"));
  }, []);

  function switchMode(newMode: AuthMode) {
    setError(null);
    setInfo(null);
    setPassword("");
    setConfirm("");
    setOtp("");
    setMode(newMode);
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setInfo(null);

    // Client-side validations
    if ((mode === "register" || mode === "new_password") && password !== confirm) {
      return setError("Passwords do not match.");
    }
    if ((mode === "register" || mode === "new_password") && password.length < 10) {
      return setError("Password must be at least 10 characters.");
    }

    setBusy(true);

    try {
      if (mode === "login") {
        await api("/api/auth/login", { method: "POST", json: { email, password } });
        const next = new URLSearchParams(location.search).get("next");
        router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/now");
        router.refresh();
      } else if (mode === "register") {
        await api("/api/auth/register", { method: "POST", json: { name, email, password } });
        const next = new URLSearchParams(location.search).get("next");
        router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/now");
        router.refresh();
      } else if (mode === "forgot") {
        const res = await api<{ ok: boolean; message: string }>("/api/auth/forgot-password", {
          method: "POST",
          json: { email },
        });
        setInfo(res.message);
        setMode("verify_otp");
      } else if (mode === "verify_otp") {
        const res = await api<{ ok: boolean; resetToken: string }>("/api/auth/verify-otp", {
          method: "POST",
          json: { email, otp },
        });
        setResetToken(res.resetToken);
        setMode("new_password");
      } else if (mode === "new_password") {
        await api<{ ok: boolean; message: string }>("/api/auth/reset-password", {
          method: "POST",
          json: { resetToken, password },
        });
        setMode("reset_success");
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "An unexpected error occurred. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  async function resendOtp() {
    setError(null);
    setInfo(null);
    setBusy(true);
    try {
      const res = await api<{ ok: boolean; message: string }>("/api/auth/forgot-password", {
        method: "POST",
        json: { email },
      });
      setInfo("A new verification code has been sent to your email.");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to resend verification code.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <div className="auth-hero">
        <div className="brand" style={{ padding: 0 }}>
          <div className="brand-mark">
            <LineChart size={18} strokeWidth={2.6} />
          </div>
          <div className="brand-name">
            Expense AI<small>Personal finance</small>
          </div>
        </div>
        <div style={{ position: "relative" }}>
          <h1>Your money, understood.</h1>
          <p className="dim" style={{ maxWidth: "42ch", margin: "14px 0 30px" }}>
            Turn your HDFC and Google Pay statements into a private, persistent analytics system with an assistant that answers from your real numbers.
          </p>
          <div className="points">
            <div>
              <ShieldCheck />{" "}
              <span>
                <b style={{ color: "var(--text)" }}>Private by design.</b> PDFs are parsed locally on the server, passwords are never stored, and no raw statement leaves your machine.
              </span>
            </div>
            <div>
              <Sparkles />{" "}
              <span>
                <b style={{ color: "var(--text)" }}>Grounded answers.</b> The assistant queries your database - it cannot invent a transaction.
              </span>
            </div>
            <div>
              <Lock />{" "}
              <span>
                <b style={{ color: "var(--text)" }}>Personal security.</b> Hashed passwords, encrypted OTPs, httpOnly sessions, CSRF and rate-limit protection.
              </span>
            </div>
          </div>
        </div>
        <div className="faint" style={{ fontSize: 12, position: "relative" }}>
          Not affiliated with HDFC Bank. Statements are uploaded manually - no bank credentials are ever requested.
        </div>
      </div>

      <div className="auth-form">
        <form className="card auth-card glow stack" onSubmit={submit} style={{ gap: 16 }}>
          <div>
            <h2 style={{ fontSize: 22 }}>
              {mode === "register" && "Create your account"}
              {mode === "login" && "Welcome back"}
              {mode === "forgot" && "Reset password"}
              {mode === "verify_otp" && "Enter verification code"}
              {mode === "new_password" && "Set new password"}
              {mode === "reset_success" && "Password reset complete"}
              {mode === "loading" && "Expense AI"}
            </h2>
            <p className="dim" style={{ margin: "4px 0 0" }}>
              {mode === "register" && "Set up your personal financial analytics account."}
              {mode === "login" && "Sign in to open your financial dashboard."}
              {mode === "forgot" && "Enter your email to receive a 6-digit verification code."}
              {mode === "verify_otp" && `Enter the code sent to ${email}.`}
              {mode === "new_password" && "Choose a strong new password for your account."}
              {mode === "reset_success" && "Your password has been updated successfully."}
            </p>
          </div>

          {error && <Alert kind="error">{error}</Alert>}
          {info && <Alert kind="info">{info}</Alert>}

          {mode === "loading" ? (
            <div className="dim">Loading…</div>
          ) : mode === "reset_success" ? (
            <div className="stack" style={{ gap: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text)" }}>
                <CheckCircle2 size={20} color="#16a34a" />
                <span>You can now sign in using your new password.</span>
              </div>
              <button className="btn primary" type="button" onClick={() => switchMode("login")}>
                Sign in
              </button>
            </div>
          ) : (
            <>
              {mode === "register" && (
                <Field label="Your name">
                  <input
                    className="input"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    required
                    maxLength={80}
                    autoComplete="name"
                    placeholder="e.g. Alex Smith"
                  />
                </Field>
              )}

              {(mode === "login" || mode === "register" || mode === "forgot") && (
                <Field label="Email">
                  <input
                    className="input"
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    required
                    autoComplete="email"
                    autoFocus={mode !== "register"}
                    placeholder="you@example.com"
                  />
                </Field>
              )}

              {mode === "verify_otp" && (
                <Field label="6-Digit Verification Code" hint="Check your inbox (or spam folder) for the code.">
                  <input
                    className="input"
                    type="text"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    value={otp}
                    onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
                    required
                    autoFocus
                    placeholder="123456"
                    style={{ letterSpacing: "4px", fontSize: "18px", fontWeight: 700, fontFamily: "monospace" }}
                  />
                </Field>
              )}

              {(mode === "login" || mode === "register" || mode === "new_password") && (
                <Field
                  label={mode === "new_password" ? "New password" : "Password"}
                  hint={mode !== "login" ? "At least 10 characters, mixing letters and numbers or symbols." : undefined}
                >
                  <input
                    className="input"
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    required
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                  />
                </Field>
              )}

              {(mode === "register" || mode === "new_password") && (
                <Field label="Confirm password">
                  <input
                    className="input"
                    type="password"
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                    required
                    autoComplete="new-password"
                  />
                </Field>
              )}

              <button className="btn primary" disabled={busy} type="submit" style={{ marginTop: 4 }}>
                {busy ? (
                  "Please wait…"
                ) : (
                  <>
                    {mode === "login" && "Sign in"}
                    {mode === "register" && "Create account"}
                    {mode === "forgot" && "Send verification code"}
                    {mode === "verify_otp" && "Verify code"}
                    {mode === "new_password" && "Reset password"}
                  </>
                )}
              </button>

              {/* Navigation Links between flows */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8, fontSize: 13 }}>
                {mode === "login" && (
                  <>
                    {registrationAllowed && (
                      <div className="dim">
                        Don't have an account?{" "}
                        <button
                          type="button"
                          className="link"
                          style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "var(--accent)" }}
                          onClick={() => switchMode("register")}
                        >
                          Create account
                        </button>
                      </div>
                    )}
                    <div>
                      <button
                        type="button"
                        className="link"
                        style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "var(--dim)" }}
                        onClick={() => switchMode("forgot")}
                      >
                        Forgot password?
                      </button>
                    </div>
                  </>
                )}

                {mode === "register" && (
                  <div className="dim">
                    Already have an account?{" "}
                    <button
                      type="button"
                      className="link"
                      style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "var(--accent)" }}
                      onClick={() => switchMode("login")}
                    >
                      Sign in
                    </button>
                  </div>
                )}

                {mode === "verify_otp" && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <button
                      type="button"
                      disabled={busy}
                      style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "var(--dim)" }}
                      onClick={resendOtp}
                    >
                      Resend OTP code
                    </button>
                    <button
                      type="button"
                      style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "var(--accent)" }}
                      onClick={() => switchMode("login")}
                    >
                      Cancel
                    </button>
                  </div>
                )}

                {mode === "forgot" && (
                  <div>
                    <button
                      type="button"
                      style={{ background: "none", border: "none", padding: 0, font: "inherit", cursor: "pointer", color: "var(--accent)", display: "inline-flex", alignItems: "center", gap: 4 }}
                      onClick={() => switchMode("login")}
                    >
                      <ArrowLeft size={14} /> Back to Sign in
                    </button>
                  </div>
                )}
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
