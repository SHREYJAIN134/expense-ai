"use client";
import { Database, Download, KeyRound, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Alert, Badge, Card, Field, Modal, Toggle, useToast } from "@/components/ui";
import { api, ApiClientError } from "@/lib/client/api";
import { categoryLabel } from "@/lib/client/format";

export interface SettingsRes {
  user: { id: string; name: string; email: string };
  settings: { currency: string; monthStartDay: number; aiClassification: boolean; aiNarration: boolean; safetyBuffer: number | null; changeMinPct: number; changeMinAmount: number; changeMinTxns: number; anomalyMinAmount: number; includeDetectedRecurring: boolean; reserveBudgets: boolean };
  categories: { name: string; color: string; isSystem: boolean; subcategories: { name: string; isSystem: boolean }[] }[];
  ai: { configured: boolean; provider: string };
  hasDemoData: boolean;
}

export function Profile({ d, onSaved }: { d: SettingsRes; onSaved: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState(d.user.name);
  const [email, setEmail] = useState(d.user.email);
  const [err, setErr] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try { await api("/api/settings/profile", { method: "PATCH", json: { name, email } }); toast("Profile updated"); onSaved(); } catch (x) { setErr(x instanceof ApiClientError ? x.message : "Failed"); }
  }
  return (
    <Card title="Profile">
      <form className="stack" onSubmit={save}>
        {err && <Alert kind="error">{err}</Alert>}
        <div className="form-grid">
          <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} /></Field>
          <Field label="Email"><input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        </div>
        <div><button className="btn primary" type="submit">Save profile</button></div>
      </form>
    </Card>
  );
}

export function Password() {
  const { toast } = useToast();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    try { await api("/api/auth/password", { method: "POST", json: { current: cur, next } }); toast("Password changed. Other devices were signed out."); setCur(""); setNext(""); } catch (x) { setErr(x instanceof ApiClientError ? x.message : "Failed"); }
  }
  return (
    <Card title="Password" sub="Changing it signs out every other session">
      <form className="stack" onSubmit={save}>
        {err && <Alert kind="error">{err}</Alert>}
        <div className="form-grid">
          <Field label="Current password"><input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required /></Field>
          <Field label="New password" hint="At least 10 characters."><input className="input" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required /></Field>
        </div>
        <div><button className="btn" type="submit"><KeyRound /> Change password</button></div>
      </form>
    </Card>
  );
}

export function Preferences({ d, onSaved }: { d: SettingsRes; onSaved: () => void }) {
  const { toast } = useToast();
  async function patch(p: object) {
    try { await api("/api/settings", { method: "PATCH", json: p }); toast("Saved"); onSaved(); } catch (x) { toast(x instanceof ApiClientError ? x.message : "Failed", "error"); }
  }
  return (
    <Card title="Preferences">
      <div className="form-grid">
        <Field label="Currency" hint="Amounts are always stored in the statement's currency (INR for HDFC).">
          <select className="select" value={d.settings.currency} onChange={(e) => patch({ currency: e.target.value })}>{["INR", "USD", "EUR", "GBP"].map((c) => <option key={c}>{c}</option>)}</select>
        </Field>
        <Field label="Financial month starts on day" hint="e.g. 25 if your salary arrives on the 25th. Affects monthly totals, budgets and 'this month'.">
          <select className="select" value={d.settings.monthStartDay} onChange={(e) => patch({ monthStartDay: Number(e.target.value) })}>{Array.from({ length: 28 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n === 1 ? "1st (calendar month)" : `${n}th`}</option>)}</select>
        </Field>
      </div>
    </Card>
  );
}

export function IntelligenceSettings({ d, onSaved }: { d: SettingsRes; onSaved: () => void }) {
  const { toast } = useToast();
  const s = d.settings;
  const [buffer, setBuffer] = useState(s.safetyBuffer === null ? "" : String(s.safetyBuffer));
  const [pct, setPct] = useState(String(s.changeMinPct));
  const [amount, setAmount] = useState(String(s.changeMinAmount));
  const [txns, setTxns] = useState(String(s.changeMinTxns));
  const [unusual, setUnusual] = useState(String(s.anomalyMinAmount));
  async function patch(p: object) {
    try { await api("/api/settings", { method: "PATCH", json: p }); toast("Saved"); onSaved(); } catch (x) { toast(x instanceof ApiClientError ? x.message : "Failed", "error"); }
  }
  const num = (v: string, min: number) => (v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= min ? Number(v) : null);
  return (
    <Card title="Financial intelligence" sub="How estimates and alerts are calculated. All of this is deterministic and uses only your own data.">
      <div id="intelligence" className="stack" style={{ gap: 16 }}>
        <div className="form-grid">
          <Field label="Safety buffer (₹)" hint="Kept aside in safe-to-spend. Leave empty for automatic (10% of your typical monthly spending).">
            <input className="input" type="number" min={0} placeholder="Automatic" value={buffer} onChange={(e) => setBuffer(e.target.value)} onBlur={() => { const next = buffer.trim() === "" ? null : num(buffer, 0); if (next !== s.safetyBuffer && (buffer.trim() === "" || next !== null)) patch({ safetyBuffer: next }); }} />
          </Field>
          <Field label="Unusual-activity minimum (₹)" hint="Payments below this are never flagged as unusual.">
            <input className="input" type="number" min={0} value={unusual} onChange={(e) => setUnusual(e.target.value)} onBlur={() => { const v = num(unusual, 0); if (v !== null && v !== s.anomalyMinAmount) patch({ anomalyMinAmount: v }); }} />
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Call out a change when it is at least (%)" hint="Category / merchant spending versus the previous equivalent period.">
            <input className="input" type="number" min={1} value={pct} onChange={(e) => setPct(e.target.value)} onBlur={() => { const v = num(pct, 1); if (v !== null && v !== s.changeMinPct) patch({ changeMinPct: v }); }} />
          </Field>
          <Field label="...and at least (₹)">
            <input className="input" type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={() => { const v = num(amount, 0); if (v !== null && v !== s.changeMinAmount) patch({ changeMinAmount: v }); }} />
          </Field>
          <Field label="...across at least (transactions)" hint="Avoids conclusions from one-off purchases.">
            <input className="input" type="number" min={1} max={50} value={txns} onChange={(e) => setTxns(e.target.value)} onBlur={() => { const v = num(txns, 1); if (v !== null && Math.round(v) !== s.changeMinTxns) patch({ changeMinTxns: Math.round(v) }); }} />
          </Field>
        </div>
        <Toggle checked={s.includeDetectedRecurring} onChange={(v) => patch({ includeDetectedRecurring: v })} label="Count recurring payments detected from my history" hint="When off, safe-to-spend only subtracts obligations you entered yourself." />
        <Toggle checked={s.reserveBudgets} onChange={(v) => patch({ reserveBudgets: v })} label="Set aside the unspent part of my budgets" hint="Budget money you have not spent yet is treated as committed in safe-to-spend." />
      </div>
    </Card>
  );
}

export function AiSettings({ d, onSaved }: { d: SettingsRes; onSaved: () => void }) {
  const { toast } = useToast();
  async function patch(p: object) {
    try { await api("/api/settings", { method: "PATCH", json: p }); toast("Saved"); onSaved(); } catch (x) { toast(x instanceof ApiClientError ? x.message : "Failed", "error"); }
  }
  return (
    <Card title="AI settings" right={<Badge tone={d.ai.configured ? "pos" : "warn"}>{d.ai.configured ? `Provider configured (${d.ai.provider})` : "No AI key configured"}</Badge>}>
      <div className="stack" style={{ gap: 16 }}>
        {!d.ai.configured && <Alert kind="info">Everything works without an AI provider: classification uses rules, merchant mappings, history and keywords, and the assistant answers directly from your data. To enable optional AI help, set <span className="mono">AI_API_KEY</span> in <span className="mono">.env.local</span> and restart. The key is read only on the server.</Alert>}
        <Toggle checked={d.settings.aiClassification} onChange={(v) => patch({ aiClassification: v })} label="AI classification for ambiguous transactions" hint="Sends only a cleaned merchant/narration snippet (no amounts, dates, account numbers or PDFs) for rows the rules couldn't place." />
        <Toggle checked={d.settings.aiNarration} onChange={(v) => patch({ aiNarration: v })} label="AI phrasing of assistant answers" hint="The model only rewords numbers already computed from your data; responses containing any other number are discarded." />
      </div>
    </Card>
  );
}

export function Categories({ d, onChanged }: { d: SettingsRes; onChanged: () => void }) {
  const { toast } = useToast();
  const [cat, setCat] = useState("");
  const [parent, setParent] = useState("");
  const [sub, setSub] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { if (!parent && d.categories[0]) setParent(d.categories[0].name); }, [d.categories, parent]);

  async function add(body: object) {
    setErr(null);
    try { await api("/api/settings/categories", { method: "POST", json: body }); toast("Category added"); setCat(""); setSub(""); onChanged(); } catch (x) { setErr(x instanceof ApiClientError ? x.message : "Failed"); }
  }
  async function remove(category: string, subcategory?: string) {
    setErr(null);
    try { await api("/api/settings/categories", { method: "DELETE", json: { category, subcategory } }); onChanged(); } catch (x) { setErr(x instanceof ApiClientError ? x.message : "Failed"); }
  }
  return (
    <Card title="Category management" sub="Built-in categories are fixed; add your own top-level categories or sub-categories. Custom ones can be removed once unused.">
      {err && <div style={{ marginBottom: 12 }}><Alert kind="error">{err}</Alert></div>}
      <div className="grid g2" style={{ marginBottom: 16 }}>
        <div className="row" style={{ gap: 8 }}><input className="input" placeholder="New category, e.g. PETS" value={cat} onChange={(e) => setCat(e.target.value)} maxLength={40} /><button className="btn" disabled={cat.trim().length < 2} onClick={() => add({ category: cat })}><Plus /> Add</button></div>
        <div className="row" style={{ gap: 8 }}>
          <select className="select" style={{ maxWidth: 160 }} value={parent} onChange={(e) => setParent(e.target.value)}>{d.categories.map((c) => <option key={c.name} value={c.name}>{categoryLabel(c.name)}</option>)}</select>
          <input className="input" placeholder="New sub-category" value={sub} onChange={(e) => setSub(e.target.value)} maxLength={40} />
          <button className="btn" disabled={sub.trim().length < 2} onClick={() => add({ category: parent, subcategory: sub })}><Plus /> Add</button>
        </div>
      </div>
      <div className="stack" style={{ gap: 10, maxHeight: 360, overflow: "auto" }}>
        {d.categories.map((c) => (
          <div key={c.name} className="row wrap" style={{ gap: 6, alignItems: "flex-start" }}>
            <span className="row" style={{ gap: 7, width: 170, flex: "none", fontWeight: 600, fontSize: 13 }}><span className="dot" style={{ background: c.color }} />{categoryLabel(c.name)} {!c.isSystem && <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={() => remove(c.name)} aria-label={`Remove ${c.name}`}><Trash2 /></button>}</span>
            <div className="row wrap grow" style={{ gap: 5 }}>
              {c.subcategories.map((s) => <Badge key={s.name}>{s.name}{!s.isSystem && <button style={{ background: "none", border: "none", cursor: "pointer", color: "var(--neg)", padding: 0 }} onClick={() => remove(c.name, s.name)} aria-label={`Remove ${s.name}`}>×</button>}</Badge>)}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

export function DataCard({ d, onChanged }: { d: SettingsRes; onChanged: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  async function demo(load: boolean) {
    setBusy(true);
    try {
      if (load) { const r = await api<{ transactions: number }>("/api/settings/demo", { method: "POST" }); toast(`Loaded ${r.transactions} synthetic transactions`); }
      else { const r = await api<{ removed: number }>("/api/settings/demo", { method: "DELETE" }); toast(`Removed ${r.removed} demo transactions`); }
      onChanged();
    } catch (x) { toast(x instanceof ApiClientError ? x.message : "Failed", "error"); } finally { setBusy(false); }
  }
  const links = [
    ["/api/export/transactions", "All transactions (CSV)"],
    ["/api/export/summary", "Financial summary (CSV)"],
    ["/api/export/analytics", "Analytics data (JSON)"],
    ["/api/export/report", "Printable report (HTML → PDF)"],
    ["/api/export/all", "Complete backup (JSON)"],
  ];
  return (
    <Card title="Data & export">
      <div className="stack" style={{ gap: 18 }}>
        <div className="row wrap">
          {links.map(([href, label]) => <a key={href} className="btn" href={href}><Download /> {label}</a>)}
        </div>
        <div className="card" style={{ padding: 14 }}>
          <div className="row spread wrap">
            <div><b>Demo data</b> <Badge tone="demo">SYNTHETIC</Badge><div className="dim" style={{ fontSize: 12.5 }}>Realistic but fake transactions across several months, for trying the charts before uploading real statements. Removing it never touches your real data.</div></div>
            {d.hasDemoData ? <button className="btn danger outline" disabled={busy} onClick={() => demo(false)}>Remove demo data</button> : <button className="btn" disabled={busy} onClick={() => demo(true)}><Database /> {busy ? "Generating…" : "Load demo data"}</button>}
          </div>
        </div>
      </div>
    </Card>
  );
}

export function Danger() {
  const router = useRouter();
  const { toast } = useToast();
  const [mode, setMode] = useState<null | "data" | "account">(null);
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const need = mode === "data" ? "DELETE MY DATA" : "DELETE MY ACCOUNT";

  async function run() {
    setBusy(true);
    setErr(null);
    try {
      if (mode === "data") { await api("/api/settings/delete-data", { method: "POST", json: { password, confirm: need } }); toast("All financial data deleted"); setMode(null); router.push("/now"); router.refresh(); }
      else { await api("/api/settings/account", { method: "DELETE", json: { password, confirm: need } }); router.replace("/login"); router.refresh(); }
    } catch (x) { setErr(x instanceof ApiClientError ? x.message : "Failed"); } finally { setBusy(false); setPassword(""); }
  }
  return (
    <>
      <Card title="Danger zone" sub="These actions are permanent. Export a backup first." className="danger-card">
        <div className="stack" style={{ gap: 12 }}>
          <div className="row spread wrap"><div><b>Delete all financial data</b><div className="dim" style={{ fontSize: 12.5 }}>Statements, transactions, budgets, recurring items, goals, insights and chats. Your login stays.</div></div><button className="btn danger outline" onClick={() => { setMode("data"); setPhrase(""); setErr(null); }}><Trash2 /> Delete data…</button></div>
          <div className="row spread wrap" style={{ borderTop: "1px solid var(--border)", paddingTop: 12 }}><div><b>Delete account</b><div className="dim" style={{ fontSize: 12.5 }}>Removes your account and everything in it.</div></div><button className="btn danger outline" onClick={() => { setMode("account"); setPhrase(""); setErr(null); }}><Trash2 /> Delete account…</button></div>
        </div>
      </Card>
      {mode && (
        <Modal title={mode === "data" ? "Delete all financial data?" : "Delete your account?"} onClose={() => setMode(null)}>
          <div className="stack">
            <Alert kind="error">This cannot be undone. {mode === "data" ? "Every statement, transaction, budget and chat will be erased." : "Your account and all data will be erased and you will be signed out."}</Alert>
            {err && <Alert kind="error">{err}</Alert>}
            <Field label="Your password"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" /></Field>
            <Field label={`Type ${need} to confirm`}><input className="input mono" value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" /></Field>
            <div className="row" style={{ justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setMode(null)}>Cancel</button>
              <button className="btn danger" disabled={busy || phrase !== need || !password} onClick={run}>{busy ? "Deleting…" : "Permanently delete"}</button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
