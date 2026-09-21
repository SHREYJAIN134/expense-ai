"use client";
import { Database, Lock, Plus } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api, ApiClientError } from "@/lib/client/api";
import { Alert, useToast } from "./ui";

/** Empty state for a brand-new account: an empty strip waiting for its first statement. */
export default function Onboarding({ onLoaded }: { onLoaded: () => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { toast } = useToast();

  async function loadDemo() {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ statements: number; transactions: number }>("/api/settings/demo", { method: "POST" });
      toast(`Loaded ${r.transactions} synthetic demo transactions`);
      onLoaded();
    } catch (e) {
      setErr(e instanceof ApiClientError ? e.message : "Could not load demo data.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="sheet fade-in" style={{ padding: "36px clamp(20px, 4vw, 44px)", maxWidth: 760, margin: "24px auto" }}>
      <svg width="100%" height="84" viewBox="0 0 380 84" role="img" aria-label="An empty strip waiting for data" preserveAspectRatio="none">
        <line x1="0" y1="50" x2="380" y2="50" stroke="var(--ink)" strokeWidth="1.4" strokeDasharray="3 6" />
        {Array.from({ length: 14 }).map((_, i) => <line key={i} x1={10 + i * 27} y1={44} x2={10 + i * 27} y2={56} stroke="var(--hair)" strokeWidth="2" />)}
      </svg>
      <h2 className="serif" style={{ fontSize: 30, fontWeight: 500, letterSpacing: "-.02em", marginTop: 8 }}>Your line starts with one statement.</h2>
      <p className="dim" style={{ marginTop: 8, maxWidth: "56ch" }}>
        Bring in an HDFC statement or a Google Pay export. We read it here, check that it adds up, and only then add it to your ledger. Every number you see afterwards can be traced back to the rows it came from.
      </p>
      {err && <div style={{ marginTop: 14 }}><Alert kind="error">{err}</Alert></div>}
      <div className="row wrap" style={{ gap: 12, marginTop: 22 }}>
        <Link href="/bring-in" className="btn solid lg"><Plus size={16} strokeWidth={2} /> Bring in a statement</Link>
        <button className="btn ghost lg" onClick={loadDemo} disabled={busy}>
          <Database /> {busy ? "Generating…" : "Explore with demo data"}
        </button>
        <span className="faint row" style={{ gap: 6, fontSize: 12.5 }}><Lock size={13} /> PDFs are never stored</span>
      </div>
      <p className="faint" style={{ fontSize: 12, marginTop: 16 }}>Demo data is synthetic and clearly labelled. Remove it any time in the Vault.</p>
    </div>
  );
}
