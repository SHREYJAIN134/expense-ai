"use client";
import { Lock, LineChart, ShieldCheck, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api, ApiClientError } from "@/lib/client/api";
import { Alert, Field } from "@/components/ui";

export default function AuthForm() {
  const router = useRouter();
  const [mode, setMode] = useState<"loading" | "login" | "setup">("loading");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ hasUsers: boolean; registrationOpen: boolean }>("/api/auth/status")
      .then((s) => setMode(s.hasUsers ? "login" : "setup"))
      .catch(() => setMode("login"));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "setup" && password !== confirm) return setError("Passwords do not match.");
    setBusy(true);
    try {
      if (mode === "setup") await api("/api/auth/register", { method: "POST", json: { name, email, password } });
      else await api("/api/auth/login", { method: "POST", json: { email, password } });
      const next = new URLSearchParams(location.search).get("next");
      router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/now");
      router.refresh();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Could not sign in.");
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
          <div className="brand-name">Expense AI<small>Personal finance</small></div>
        </div>
        <div style={{ position: "relative" }}>
          <h1>Your money, understood.</h1>
          <p className="dim" style={{ maxWidth: "42ch", margin: "14px 0 30px" }}>
            Turn your HDFC statements into a private, persistent analytics system with an assistant that answers from your real numbers.
          </p>
          <div className="points">
            <div><ShieldCheck /> <span><b style={{ color: "var(--text)" }}>Private by design.</b> PDFs are parsed locally on the server, passwords are never stored, and no raw statement leaves your machine.</span></div>
            <div><Sparkles /> <span><b style={{ color: "var(--text)" }}>Grounded answers.</b> The assistant queries your database - it cannot invent a transaction.</span></div>
            <div><Lock /> <span><b style={{ color: "var(--text)" }}>Single-user security.</b> Hashed password, httpOnly sessions, CSRF and rate-limit protection.</span></div>
          </div>
        </div>
        <div className="faint" style={{ fontSize: 12, position: "relative" }}>Not affiliated with HDFC Bank. Statements are uploaded manually - no bank credentials are ever requested.</div>
      </div>

      <div className="auth-form">
        <form className="card auth-card glow stack" onSubmit={submit} style={{ gap: 16 }}>
          <div>
            <h2 style={{ fontSize: 22 }}>{mode === "setup" ? "Create your account" : "Welcome back"}</h2>
            <p className="dim" style={{ margin: "4px 0 0" }}>
              {mode === "setup" ? "First run: set up the single private account for this app." : "Sign in to open your financial dashboard."}
            </p>
          </div>
          {error && <Alert kind="error">{error}</Alert>}
          {mode === "loading" ? (
            <div className="dim">Loading…</div>
          ) : (
            <>
              {mode === "setup" && (
                <Field label="Your name">
                  <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} autoComplete="name" />
                </Field>
              )}
              <Field label="Email">
                <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="username" autoFocus />
              </Field>
              <Field label="Password" hint={mode === "setup" ? "At least 10 characters, mixing letters and numbers or symbols." : undefined}>
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete={mode === "setup" ? "new-password" : "current-password"} />
              </Field>
              {mode === "setup" && (
                <Field label="Confirm password">
                  <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required autoComplete="new-password" />
                </Field>
              )}
              <button className="btn primary" disabled={busy} type="submit">
                {busy ? "Please wait…" : mode === "setup" ? "Create account" : "Sign in"}
              </button>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
