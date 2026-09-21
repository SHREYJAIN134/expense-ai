"use client";
import { AlertTriangle, FileText, Link2, List, Lock, Plus, ShieldCheck, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, type ReactNode } from "react";
import { PageTitle } from "@/components/ll";
import { ErrorState, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/client/api";
import { longDate, shortDate } from "@/lib/client/format";
import { addDays } from "@/lib/util/dates";
import { AiSettings, Categories, DataCard, Danger, IntelligenceSettings, Password, Preferences, Profile, type SettingsRes } from "./settings-parts";
import { StatementsSection } from "./statements";

interface StatementLite { id: string; bank: string; accountMask: string | null; periodStart: string | null; periodEnd: string | null; status: string; transactionCount: number; reconciliationStatus: string | null; isDemo: boolean }

const BANK_NAME: Record<string, string> = { HDFC: "HDFC Bank", GOOGLE_PAY: "Google Pay" };
const daysBetween = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

function Coverage({ rows, from, to }: { rows: StatementLite[]; from: string; to: string }) {
  const span = Math.max(1, daysBetween(from, to));
  const months: string[] = [];
  for (let d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) months.push(d.toISOString().slice(0, 10));
  return (
    <div>
      <div style={{ position: "relative", height: 10, borderRadius: 5, background: "var(--soft)", marginTop: 10 }}>
        {rows.map((r) => {
          const a = Math.max(0, daysBetween(from, r.periodStart!));
          const b = Math.min(span, daysBetween(from, r.periodEnd!) + 1);
          return <i key={r.id} title={`${longDate(r.periodStart!)} → ${longDate(r.periodEnd!)}`} style={{ position: "absolute", left: `${(a / span) * 100}%`, width: `${Math.max(1.5, ((b - a) / span) * 100)}%`, top: 0, bottom: 0, background: "var(--ink)", borderRadius: 5 }} />;
        })}
      </div>
      <div className="row mono faint" style={{ justifyContent: "space-between", fontSize: 10.5, marginTop: 4 }}>
        {months.slice(0, 8).map((m) => <span key={m}>{new Date(m + "T00:00:00Z").toLocaleString("en-IN", { month: "short", timeZone: "UTC" }).toUpperCase()}</span>)}
      </div>
    </div>
  );
}

function LedgerCol({ tone, title, items, note }: { tone: string; title: string; items: { t: string; icon: ReactNode }[]; note: string }) {
  return (
    <div>
      <div className="lab" style={{ color: tone }}>{title}</div>
      <ul style={{ listStyle: "none", margin: "8px 0 0", padding: 0, fontSize: 14 }}>
        {items.map((i) => <li key={i.t} style={{ padding: "9px 0", borderTop: "1px solid var(--hair2)", display: "flex", gap: 10, alignItems: "center" }}><span style={{ color: tone, display: "inline-flex" }}>{i.icon}</span>{i.t}</li>)}
      </ul>
      <p className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>{note}</p>
    </div>
  );
}

export default function VaultPage() {
  const stm = useApi<{ statements: StatementLite[] }>("/api/statements");
  const q = useApi<SettingsRes>("/api/settings");
  const today = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // #intelligence links land on a section that renders after the data loads
  useEffect(() => {
    if (!q.data || typeof location === "undefined" || !location.hash) return;
    document.getElementById(location.hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [q.data]);

  const imported = (stm.data?.statements ?? []).filter((s) => s.status === "imported" && s.periodStart && s.periodEnd);
  const banks = useMemo(() => [...new Set(imported.map((s) => s.bank))], [imported]);
  const from = imported.length ? imported.map((s) => s.periodStart!).sort()[0] : today;
  const latest = imported.length ? imported.map((s) => s.periodEnd!).sort().slice(-1)[0] : today;
  const to = addDays(latest > today ? latest : today, 0);

  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  const d = q.data;

  return (
    <div className="fade-in">
      <PageTitle lab="Under your avatar" title="Vault" sub="Your sources, your privacy, your data — and exactly what leaves this server, if anything." />

      <div className="vault-grid" style={{ display: "grid", gridTemplateColumns: "1.05fr 1fr", gap: 64 }}>
        <div style={{ minWidth: 0 }}>
          <div className="lab">Sources</div>
          <div style={{ marginTop: 6 }}>
            {!stm.data ? <Skeleton h={120} /> : banks.length === 0 ? (
              <p className="dim" style={{ padding: "16px 0", borderTop: "1px solid var(--hair)" }}>No statements yet. Bring one in to start your ledger.</p>
            ) : banks.map((bank) => {
              const rows = imported.filter((s) => s.bank === bank);
              const end = rows.map((r) => r.periodEnd!).sort().slice(-1)[0];
              const stale = daysBetween(end, today) > 3;
              const events = rows.reduce((a, r) => a + r.transactionCount, 0);
              const ok = rows.every((r) => r.reconciliationStatus === "reconciled");
              return (
                <div key={bank} style={{ padding: "16px 0", borderTop: "1px solid var(--hair)", display: "grid", gridTemplateColumns: "44px 1fr", gap: 14, alignItems: "start" }}>
                  <span className="glyph" style={{ width: 40, height: 40, border: "1.5px solid var(--ink)", background: "var(--sheet)" }}>{bank === "HDFC" ? "HD" : "GP"}</span>
                  <div>
                    <div className="row spread wrap"><b style={{ fontSize: 15 }}>{BANK_NAME[bank] ?? bank}</b><span className={`fresh ${stale ? "stale" : ""}`}><span className="dot" />{stale ? `${daysBetween(end, today)} days behind` : "up to date"} · {shortDate(end)}</span></div>
                    <div className="faint" style={{ fontSize: 12.5 }}>{bank === "GOOGLE_PAY" ? "Transaction statement PDF" : "Account statement PDF"}{rows[0].accountMask ? ` · ••${rows[0].accountMask}` : ""} · {rows.length} statement{rows.length === 1 ? "" : "s"} · {events} rows{ok ? " · reconciled" : ""}</div>
                    <Coverage rows={rows} from={from} to={to} />
                  </div>
                </div>
              );
            })}
            <div className="row wrap" style={{ padding: "14px 0", borderTop: "1px solid var(--hair)", borderBottom: "1px solid var(--hair)", gap: 14 }}>
              <Link href="/bring-in" className="btn"><Plus size={15} strokeWidth={2} /> Add a source</Link>
              <span className="faint" style={{ fontSize: 13 }}>HDFC account statements and Google Pay transaction statements are supported today.</span>
            </div>
          </div>

          <div className="lab" style={{ marginTop: 30 }}>Statements</div>
          <div style={{ marginTop: 6 }}><StatementsSection /></div>
          <p className="faint" style={{ fontSize: 12.5, marginTop: 8 }}>The PDFs themselves are never kept — only the rows you approved. Deleting a statement removes the rows it contributed; a payment also seen in another source stays.</p>
        </div>

        <div style={{ minWidth: 0 }}>
          <div className="lab">What leaves this server</div>
          <div className="sheet" style={{ padding: "20px 22px", marginTop: 8 }}>
            <div className="privacy-cols" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 22 }}>
              <LedgerCol tone="var(--in)" title="Never stored" items={[{ t: "Statement PDFs", icon: <FileText size={16} /> }, { t: "PDF passwords", icon: <Lock size={16} /> }]} note="Read in memory, then forgotten." />
              <LedgerCol tone="var(--ink)" title="Stays on your server" items={[{ t: "Transactions", icon: <List size={16} /> }, { t: "UPI ids, references", icon: <Link2 size={16} /> }, { t: "Account last-4 only", icon: <ShieldCheck size={16} /> }]} note="Never shown to anyone else." />
              <LedgerCol tone="var(--out)" title="Never sent to an AI" items={[{ t: "UPI ids and references", icon: <X size={16} /> }, { t: "Account numbers", icon: <X size={16} /> }, { t: "Names of people you paid", icon: <X size={16} /> }]} note="Replaced by “Person 1” before any request." />
            </div>
            <div className="row" style={{ marginTop: 18, paddingTop: 16, borderTop: "1px solid var(--hair)", alignItems: "flex-start" }}>
              <span style={{ flex: 1 }}>
                <b>AI phrasing of answers</b>{d && <span className="faint"> · currently {d.settings.aiNarration && d.ai.configured ? "on" : "off"}</span>}
                <div className="faint" style={{ fontSize: 12.5 }}>Optional. It may only reword numbers we already calculated; a reply containing any other number is discarded.{d && !d.ai.configured ? " No AI key is configured, so nothing is sent." : ""}</div>
              </span>
              <a href="#ai" className="btn sm ghost">Change</a>
            </div>
          </div>

          <div className="lab" style={{ marginTop: 28 }}>Your data</div>
          <div style={{ marginTop: 10 }}>{d ? <DataCard d={d} onChanged={q.reload} /> : <Skeleton h={160} />}</div>
          <div style={{ marginTop: 16 }}><Danger /></div>
          <p className="faint row" style={{ gap: 6, fontSize: 12.5, marginTop: 10 }}><AlertTriangle size={13} /> Deleting is permanent. Export a backup first.</p>
        </div>
      </div>

      <section style={{ marginTop: 48, borderTop: "1px solid var(--ink)", paddingTop: 18 }}>
        <span className="lab">Settings</span>
        <h2 className="serif" style={{ fontSize: 30, fontWeight: 500, letterSpacing: "-.02em", marginTop: 4 }}>How Expense AI works for you</h2>
        {!d ? <div style={{ marginTop: 18 }}><Skeleton h={260} /></div> : (
          <div className="stack" style={{ gap: 16, marginTop: 18, maxWidth: 980 }}>
            <Preferences d={d} onSaved={q.reload} />
            <div id="intelligence" style={{ scrollMarginTop: 80 }}><IntelligenceSettings d={d} onSaved={q.reload} /></div>
            <div id="ai" style={{ scrollMarginTop: 80 }}><AiSettings d={d} onSaved={q.reload} /></div>
            <Categories d={d} onChanged={q.reload} />
            <Profile d={d} onSaved={q.reload} />
            <Password />
          </div>
        )}
      </section>
    </div>
  );
}
