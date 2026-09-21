"use client";
import { ChevronRight, Eye } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import type { UnusualActivity } from "@/lib/analytics/anomalies";
import type { IntelInsight } from "@/lib/analytics/intelligence";
import { PageTitle } from "@/components/ll";
import { TransactionDrawer, type TxnOptions } from "@/components/txn-drawer";
import { Empty, ErrorState, Skeleton } from "@/components/ui";
import { useApi } from "@/lib/client/api";
import { inr, longDate } from "@/lib/client/format";
import { buildSignals, type LedgerSignal, type SignalGroup } from "@/lib/client/signals";
import { IntelligenceSettings, type SettingsRes } from "../vault/settings-parts";

type Filter = "all" | SignalGroup;
const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "unusual", label: "Unusual" },
  { value: "pattern", label: "Patterns" },
  { value: "upcoming", label: "Coming up" },
  { value: "note", label: "About your data" },
];

const dayLabel = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "UTC" }).toUpperCase();

/** Baseline vs observed: the evidence behind an unusual-activity finding, on one scale. */
function Evidence({ a }: { a: UnusualActivity }) {
  const fmt = (v: number) => (a.unit === "count" ? `${v} payments` : inr(v));
  const max = Math.max(a.observed, a.baseline, 1);
  return (
    <div style={{ maxWidth: 420 }} aria-label={`Observed ${fmt(a.observed)} against a usual ${fmt(a.baseline)}`}>
      {[{ label: "Usual", v: a.baseline, solid: false }, { label: "This time", v: a.observed, solid: true }].map((r) => (
        <div key={r.label} className="row" style={{ gap: 10, marginTop: 6 }}>
          <span className="lab" style={{ width: 72 }}>{r.label}</span>
          <span style={{ flex: 1, height: 8, borderRadius: 4, background: "var(--soft)", position: "relative" }}>
            <i style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.max(2, (r.v / max) * 100)}%`, borderRadius: 4, background: r.solid ? "var(--out)" : "var(--ink3)" }} />
          </span>
          <span className="mono" style={{ fontSize: 12, width: 92, textAlign: "right" }}>{fmt(r.v)}</span>
        </div>
      ))}
      <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>Built from {a.sampleSize} earlier observation{a.sampleSize === 1 ? "" : "s"}.</div>
    </div>
  );
}

function InsightEvidence({ i }: { i: IntelInsight }) {
  const m = i.metric;
  const f = (v: number) => (m.unit === "inr" ? inr(v) : m.unit === "pct" ? `${v}%` : String(v));
  return (
    <div className="mono" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
      <div>{m.label}: <b>{f(m.value)}</b>{m.previous !== undefined && m.previous !== null ? <span className="faint"> · was {f(m.previous)}</span> : null}</div>
    </div>
  );
}

export default function SignalsPage() {
  const an = useApi<{ anomalies: UnusualActivity[] }>("/api/intelligence/anomalies?days=90");
  const ins = useApi<{ insights: IntelInsight[] }>("/api/intelligence/insights");
  const review = useApi<{ total: number }>("/api/transactions?lowConfidence=1&pageSize=1");
  const settings = useApi<SettingsRes>("/api/settings");
  const opts = useApi<TxnOptions>("/api/transactions/options");
  const [filter, setFilter] = useState<Filter>("all");
  const [openTxn, setOpenTxn] = useState<string | null>(null);

  const all = useMemo(() => buildSignals(an.data?.anomalies ?? [], ins.data?.insights ?? []), [an.data, ins.data]);
  const shown = filter === "all" ? all : all.filter((s) => s.group === filter);
  const count = (g: SignalGroup) => all.filter((s) => s.group === g).length;
  const error = an.error ?? ins.error;

  return (
    <div className="fade-in">
      <PageTitle lab="Layer · opened from the bell" title="Signals" sub="Unusual activity, patterns and what is coming up — worked out by fixed rules from your own transactions. An AI never writes or numbers a signal, and each one shows its calculation.">
        <span className="seg" role="tablist" aria-label="Filter signals">
          {FILTERS.map((f) => (
            <button key={f.value} role="tab" aria-selected={filter === f.value} className={filter === f.value ? "on" : ""} onClick={() => setFilter(f.value)}>
              {f.label} · {f.value === "all" ? all.length : count(f.value)}
            </button>
          ))}
          <Link className="chip" href="/ledger?lowConfidence=1">Needs review{review.data ? ` · ${review.data.total}` : ""}</Link>
        </span>
      </PageTitle>

      <div className="signals-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 340px", gap: 60 }}>
        <div style={{ minWidth: 0 }}>
          {error ? <ErrorState error={error} retry={() => { an.reload(); ins.reload(); }} /> : !an.data || !ins.data ? (
            <div className="stack"><Skeleton h={120} /><Skeleton h={120} /><Skeleton h={120} /></div>
          ) : shown.length === 0 ? (
            <Empty title={filter === "all" ? "Nothing notable right now" : "Nothing in this group"}>Signals appear when something meaningfully changes, repeats or stands out. Small changes are deliberately ignored.</Empty>
          ) : (
            shown.map((s) => <Entry key={s.id} s={s} onOpen={setOpenTxn} />)
          )}
        </div>

        <aside>
          <div className="lab">How sensitive should I be?</div>
          <div style={{ marginTop: 8 }}>
            {settings.data ? <IntelligenceSettings d={settings.data} onSaved={() => { settings.reload(); an.reload(); ins.reload(); }} /> : <Skeleton h={260} />}
          </div>
          <div style={{ marginTop: 16, padding: "14px 16px", borderRadius: 12, border: "1px dashed var(--est)" }}>
            <div className="row" style={{ gap: 8 }}><span className="estc"><Eye size={16} /></span><b>Evidence, not advice</b></div>
            <p className="dim" style={{ fontSize: 13, marginTop: 6 }}>“Unusual” only means different from your own past pattern. It says nothing about whether a payment is right or wrong, and it is worked out with fixed statistics, not by an AI.</p>
          </div>
        </aside>
      </div>
      {openTxn && <TransactionDrawer id={openTxn} options={opts.data} onClose={() => setOpenTxn(null)} onSaved={() => { an.reload(); ins.reload(); }} />}
    </div>
  );
}

function Entry({ s, onOpen }: { s: LedgerSignal; onOpen: (id: string) => void }) {
  const single = s.txnIds.length === 1 ? s.txnIds[0] : null;
  return (
    <div className="tl">
      <div className="when"><b>{dayLabel(s.date)}</b></div>
      <div className={`what ${s.highlight ? "hlp" : ""}`}>
        <div className="row" style={{ gap: 8 }}>
          <span className="lab">{s.kind}</span>
          {s.confidence !== null && <span className="faint" style={{ fontSize: 12 }}>confidence {Math.round(s.confidence * 100)}%</span>}
        </div>
        <h3>{s.highlight ? <span className="hl">{s.title}</span> : s.title}</h3>
        <p className="d">{s.body}</p>
        <div style={{ marginTop: 12 }}>{s.anomaly ? <Evidence a={s.anomaly} /> : s.insight ? <InsightEvidence i={s.insight} /> : null}</div>
        <details style={{ marginTop: 10 }}>
          <summary className="faint" style={{ cursor: "pointer", fontSize: 12.5 }}>How was this calculated?</summary>
          <p className="dim" style={{ fontSize: 13, marginTop: 4, maxWidth: 560 }}>{s.calculation}{s.txnIds.length ? ` Based on ${s.txnIds.length} transaction${s.txnIds.length > 1 ? "s" : ""}, on ${longDate(s.date)}.` : ""}</p>
        </details>
        <div className="row wrap" style={{ gap: 8, marginTop: 14 }}>
          <Link className="btn sm" href={s.href}>View rows <ChevronRight size={14} /></Link>
          {single && <button className="btn sm ghost" onClick={() => onOpen(single)}>Open transaction</button>}
        </div>
      </div>
    </div>
  );
}
