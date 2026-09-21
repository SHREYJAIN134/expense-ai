"use client";
/**
 * Financial-intelligence UI blocks shared by the Dashboard and the Insights page.
 * Every number shown here is computed on the server from the user's transactions; forecast-like values are always
 * labelled as estimates, and there is intentionally no overall "score".
 */
import { Activity, ArrowDownRight, ArrowUpRight, CalendarClock, Landmark, Layers, Repeat, ShieldQuestion, Store, Wallet } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { UnusualActivity } from "@/lib/analytics/anomalies";
import type { SpendingIntelligence } from "@/lib/analytics/compare";
import type { FinancialSnapshot, IntelInsight } from "@/lib/analytics/intelligence";
import type { CashFlowProjection, SafeToSpend } from "@/lib/analytics/projection";
import { MonthCompareBars, ProjectionChart } from "@/components/charts/basic";
import { Alert, Badge, Card, CardSkeleton, Empty, ErrorState, Estimate, Kpi, Seg } from "@/components/ui";
import { qs, useApi } from "@/lib/client/api";
import { categoryLabel, inr, inrCompact, longDate, shortDate } from "@/lib/client/format";

const pctText = (p: number | null) => (p === null ? "no earlier figure" : `${p > 0 ? "+" : ""}${p}%`);

/* ------------------------------- financial snapshot ------------------------------- */

type SnapUnit = "week" | "month" | "quarter" | "year";

/** Tone for a change: rising spending is bad, rising income / cash flow is good. */
function toneFor(p: number | null, goodWhenUp: boolean): "pos" | "neg" | undefined {
  if (p === null || Math.abs(p) < 1) return undefined;
  return (p > 0) === goodWhenUp ? "pos" : "neg";
}

export function FinancialSnapshotCard() {
  const [unit, setUnit] = useState<SnapUnit>("month");
  const q = useApi<{ snapshot: FinancialSnapshot }>(`/api/intelligence/snapshot${qs({ period: unit })}`);
  const s = q.data?.snapshot;
  const change = (p: number | null, good: boolean, label: string) => <span className={toneFor(p, good)}>{pctText(p)} vs {label}</span>;
  return (
    <Card
      title="Financial snapshot"
      sub={s ? <>{s.periodLabel} · {shortDate(s.from)} – {shortDate(s.to)}{s.partial ? " (in progress)" : ""} · compared with {s.previousLabel.toLowerCase()}{s.partial ? " at the same point" : ""}</> : "Where you stand right now"}
      right={<Seg label="Snapshot period" value={unit} options={[{ value: "week", label: "Week" }, { value: "month", label: "Month" }, { value: "quarter", label: "Quarter" }, { value: "year", label: "Year" }]} onChange={setUnit} />}
    >
      {q.error ? <ErrorState error={q.error} retry={q.reload} /> : !s ? <CardSkeleton h={220} /> : (
        <div className="stack" style={{ gap: 14 }}>
          {s.balance && s.balance.staleDays > 3 && <Alert kind="warn">Your latest statement ends {s.balance.staleDays} days ago ({longDate(s.balance.asOf)}). Figures below reflect your data up to then; upload a newer statement to update them.</Alert>}
          <div className="grid g3 kpis">
            <Kpi label="Current balance" icon={<Landmark size={13} />} value={s.balance ? inr(s.balance.amount) : "—"} sub={s.balance ? `as of ${shortDate(s.balance.asOf)}` : "No balance in statements"} />
            <Kpi label="Income" icon={<ArrowUpRight size={13} />} tone="pos" value={inr(s.income.value)} sub={change(s.income.changePct, true, s.previousLabel.toLowerCase())} />
            <Kpi label="Spending" icon={<ArrowDownRight size={13} />} tone="neg" value={inr(s.spending.value)} sub={<>{change(s.spending.changePct, false, s.previousLabel.toLowerCase())}{s.spending.refunded > 0 ? ` · after ${inr(s.spending.refunded)} refunds` : ""}</>} />
            <Kpi label="Net cash flow" icon={<Wallet size={13} />} tone={s.netCashFlow.value >= 0 ? "pos" : "neg"} value={inr(s.netCashFlow.value, { sign: true })} sub="money in − money out (incl. transfers)" />
            <Kpi label="Largest category" icon={<Layers size={13} />} value={s.largestCategory ? categoryLabel(s.largestCategory.category) : "—"} sub={s.largestCategory ? <>{inr(s.largestCategory.amount)} · {s.largestCategory.pctOfSpending}% of spending</> : "No spending yet"} />
            <Kpi label="Largest merchant" icon={<Store size={13} />} value={s.largestMerchant ? s.largestMerchant.merchant : "—"} sub={s.largestMerchant ? <>{inr(s.largestMerchant.amount)} · {s.largestMerchant.count} payment{s.largestMerchant.count > 1 ? "s" : ""}</> : "No spending yet"} />
            <Kpi label="Recurring obligations" icon={<Repeat size={13} />} value={<>{inr(s.recurring.monthlyTotal)}<span className="faint" style={{ fontSize: 12 }}> /mo</span></>} sub={<><Estimate /> {s.recurring.count} payments · {inr(s.recurring.expectedNext30Days)} due in 30 days</>} />
            <Kpi label="Estimated discretionary" icon={<CalendarClock size={13} />} tone={s.discretionary.shortfall > 0 ? "neg" : undefined} value={s.discretionary.safeToSpend === null ? "—" : inr(s.discretionary.safeToSpend)} sub={<><Estimate /> {s.discretionary.shortfall > 0 ? `short by ${inr(s.discretionary.shortfall)}` : `until ${shortDate(s.discretionary.through)}`}</>} />
            <Kpi label="Unusual activity" icon={<Activity size={13} />} tone={s.unusual.high > 0 ? "warn" : undefined} value={String(s.unusual.total)} sub={s.unusual.total ? <>{s.unusual.high} high · {s.unusual.medium} medium · last 30 days · <Link href="/signals" style={{ textDecoration: "underline" }}>review</Link></> : "nothing unusual in the last 30 days"} />
          </div>
          {s.unusual.top.length > 0 && (
            <div className="stack" style={{ gap: 6 }}>
              {s.unusual.top.map((u) => (
                <div key={u.id} className="row" style={{ gap: 8, fontSize: 12.5 }}>
                  <Badge tone={u.severity === "high" ? "neg" : u.severity === "medium" ? "warn" : undefined}>{u.severity}</Badge>
                  <span className="dim">{shortDate(u.date)} · {u.reason}</span>
                </div>
              ))}
            </div>
          )}
          <p className="faint" style={{ fontSize: 11.5, margin: 0 }}>
            {s.caveats.length ? `${s.caveats[0]} ` : ""}Spending excludes transfers and investments, and refunds are netted against the purchase they reverse. Estimates are based on your own history, not guarantees.
          </p>
        </div>
      )}
    </Card>
  );
}

/* --------------------------------- safe to spend --------------------------------- */

export function SafeToSpendCard() {
  const q = useApi<SafeToSpend>("/api/intelligence/safe-to-spend");
  const s = q.data;
  return (
    <Card title="Safe to spend" sub={s ? `Through ${longDate(s.to)}` : "After bills, budgets and a buffer"} right={<Estimate />}>
      {q.error ? <ErrorState error={q.error} retry={q.reload} /> : !s ? <CardSkeleton h={220} /> : s.amount === null ? (
        <Empty title="Needs a balance">Your statements don&apos;t include a running balance, so this can&apos;t be calculated.</Empty>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <div>
            <div className="num" style={{ fontSize: 30, fontWeight: 700 }}>{inr(s.amount)}</div>
            {s.shortfall > 0 && <div className="neg" style={{ fontSize: 12.5 }}>Commitments exceed your balance by about {inr(s.shortfall)}.</div>}
          </div>
          <div className="stack" style={{ gap: 8 }}>
            {s.components.map((c) => (
              <div key={c.key}>
                <div className="row spread" style={{ alignItems: "baseline" }}>
                  <span className={c.key === "balance" ? "" : "dim"}>{c.sign === -1 ? "− " : ""}{c.label}</span>
                  <span className={`num ${c.sign === -1 && c.amount > 0 ? "neg" : ""}`} style={{ fontWeight: 550 }}>{inr(c.amount)}</span>
                </div>
                <div className="faint" style={{ fontSize: 11 }}>{c.note}</div>
              </div>
            ))}
            <div className="row spread" style={{ borderTop: "1px solid var(--border)", paddingTop: 8, alignItems: "baseline" }}>
              <b>= Safe to spend</b>
              <b className="num">{inr(s.amount)}</b>
            </div>
          </div>
          {s.expectedIncomeNotCounted > 0 && <div className="faint" style={{ fontSize: 11.5 }}>Expected income of about {inr(s.expectedIncomeNotCounted)} in this window is not counted.</div>}
          {s.budgetLines.length > 0 && (
            <details style={{ fontSize: 12 }}>
              <summary className="dim" style={{ cursor: "pointer" }}>Budget commitments in detail</summary>
              <div className="stack" style={{ gap: 4, marginTop: 6 }}>
                {s.budgetLines.map((b) => <div key={b.category} className="row spread"><span className="dim">{categoryLabel(b.category)}: {inrCompact(b.remaining)} left{b.alreadyCounted > 0 ? `, ${inrCompact(b.alreadyCounted)} already in bills` : ""}</span><span className="num">{inr(b.reserved)}</span></div>)}
              </div>
            </details>
          )}
          <p className="faint" style={{ fontSize: 11.5, margin: 0 }}><b>{s.disclaimer}</b> Confidence: {s.confidence}. <Link href="/vault#intelligence" style={{ textDecoration: "underline" }}>Adjust buffer and assumptions</Link></p>
        </div>
      )}
    </Card>
  );
}

/* --------------------------------- cash-flow projection --------------------------------- */

export function ProjectionCard() {
  const q = useApi<CashFlowProjection>("/api/intelligence/projection");
  const p = q.data;
  return (
    <Card className="span-2" title="Cash-flow projection" sub="Actual balance, then estimated paths for the next 7, 14 and 30 days" right={<Estimate />}>
      {q.error ? <ErrorState error={q.error} retry={q.reload} /> : !p ? <CardSkeleton h={320} /> : (
        <div className="stack" style={{ gap: 14 }}>
          {p.staleDays > 3 && <Alert kind="warn">{p.assumptions[0]}</Alert>}
          <ProjectionChart points={p.path} today={p.today} />
          {p.balance !== null && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>By</th><th className="n">Expected credits</th><th className="n">Recurring payments</th><th className="n">Projected balance <Estimate /></th><th className="n hide-sm">After everyday spending <Estimate /></th></tr></thead>
                <tbody>
                  {p.horizons.map((h) => (
                    <tr key={h.days}>
                      <td>{h.days} days<div className="faint" style={{ fontSize: 11 }}>{shortDate(h.to)}</div></td>
                      <td className="n pos">{h.expectedCredits ? `+ ${inr(h.expectedCredits)}` : "—"}</td>
                      <td className="n neg">{h.expectedRecurring ? `− ${inr(h.expectedRecurring)}` : "—"}<div className="faint" style={{ fontSize: 11 }}>{h.knownObligations > 0 ? `${inrCompact(h.knownObligations)} entered by you` : ""}</div></td>
                      <td className="n"><b>{h.committedBalance === null ? "n/a" : inr(h.committedBalance)}</b></td>
                      <td className="n hide-sm">{h.likelyBalance === null ? "n/a" : inr(h.likelyBalance)}<div className="faint" style={{ fontSize: 11 }}>{h.likelyLow !== null ? `${inrCompact(h.likelyLow)} – ${inrCompact(h.likelyHigh!)}` : ""}</div></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="faint" style={{ fontSize: 11.5, margin: 0 }}>Actual balance: {p.balance === null ? "unknown" : `${inr(p.balance)} as of ${p.balanceAsOf ? shortDate(p.balanceAsOf) : "the last statement"}`}. Projected figures are kept apart from it. Confidence: <b>{p.confidence}</b>. {p.disclaimer}</p>
        </div>
      )}
    </Card>
  );
}

/* ------------------------------ category change vs previous ------------------------------ */

export function CategoryChangeCard({ unit = "month" }: { unit?: SnapUnit }) {
  const q = useApi<SpendingIntelligence>(`/api/intelligence/spending${qs({ period: unit })}`);
  const d = q.data;
  const notable = d?.changes.categories.slice(0, 4) ?? [];
  return (
    <Card title="Category change" sub={d ? `${d.periods.current.label} vs ${d.periods.previous.label.toLowerCase()}${d.periods.partial ? ", same point" : ""}` : "vs the previous period"}>
      {q.error ? <ErrorState error={q.error} retry={q.reload} /> : !d ? <CardSkeleton h={260} /> : !d.categories.length ? <Empty title="No spending in this period" /> : (
        <div className="stack" style={{ gap: 10 }}>
          <MonthCompareBars rows={d.categories.map((c) => ({ category: c.key, current: c.amount, previous: c.previousAmount }))} height={220} currentLabel={d.periods.current.label} previousLabel={d.periods.previous.label} />
          {notable.length ? (
            <div className="stack" style={{ gap: 4 }}>
              {notable.map((c) => (
                <div key={c.key} className="row spread" style={{ fontSize: 12.5 }}>
                  <span>{categoryLabel(c.key)}</span>
                  <span className={c.delta > 0 ? "neg" : "pos"}>{c.delta > 0 ? "+" : "−"}{inr(Math.abs(c.delta))} {c.pctChange !== null ? `(${pctText(c.pctChange)})` : "(new)"}</span>
                </div>
              ))}
            </div>
          ) : <p className="faint" style={{ fontSize: 11.5, margin: 0 }}>No category moved by at least {d.thresholds.minPct}% and {inr(d.thresholds.minAmount)} with {d.thresholds.minTxns}+ transactions, so nothing is called out.</p>}
        </div>
      )}
    </Card>
  );
}

/* ------------------------------------ insights feed ------------------------------------ */

const SEV_CLASS: Record<IntelInsight["severity"], string> = { info: "info", positive: "positive", watch: "warning", attention: "alert" };
const SEV_LABEL: Record<IntelInsight["severity"], string> = { info: "For your information", positive: "Good news", watch: "Worth a look", attention: "Needs attention" };

function metricText(m: IntelInsight["metric"]) {
  const f = (v: number) => (m.unit === "inr" ? inr(v) : m.unit === "pct" ? `${v}%` : String(v));
  return `${m.label}: ${f(m.value)}${m.previous !== undefined && m.previous !== null ? ` (was ${f(m.previous)})` : ""}`;
}

export function InsightItem({ i, compact }: { i: IntelInsight; compact?: boolean }) {
  return (
    <div className={`insight ${SEV_CLASS[i.severity]}`}>
      <b>{i.title}</b>
      <p>{i.explanation}</p>
      {!compact && (
        <div className="row wrap" style={{ gap: 8, marginTop: 8, fontSize: 12 }}>
          <Badge>{metricText(i.metric)}</Badge>
          <span className="faint">{shortDate(i.date)} · {SEV_LABEL[i.severity]}</span>
          {i.categories.slice(0, 3).map((c) => <Link key={c} className="chip" href={`/ledger?category=${encodeURIComponent(c)}`}>{categoryLabel(c)}</Link>)}
          {i.merchants.slice(0, 3).map((m) => <Link key={m} className="chip" href={`/ledger?merchant=${encodeURIComponent(m)}`}>{m}</Link>)}
        </div>
      )}
      {!compact && (
        <details style={{ marginTop: 6, fontSize: 12 }}>
          <summary className="faint" style={{ cursor: "pointer" }}>How was this calculated?</summary>
          <p style={{ margin: "4px 0 0" }}>{i.calculation}{i.txnIds.length ? ` Based on ${i.txnIds.length} transaction${i.txnIds.length > 1 ? "s" : ""}.` : ""}</p>
        </details>
      )}
    </div>
  );
}

export function InsightsCard({ limit = 6 }: { limit?: number }) {
  const q = useApi<{ insights: IntelInsight[] }>("/api/intelligence/insights");
  return (
    <Card className="span-2" title="Insights" sub="Computed by fixed rules from your own numbers - never written by an AI" right={<Link className="btn sm ghost" href="/signals">All insights</Link>}>
      {q.error ? <ErrorState error={q.error} retry={q.reload} /> : !q.data ? <CardSkeleton h={200} /> : q.data.insights.length ? (
        <div className="grid g2" style={{ gap: 10 }}>{q.data.insights.slice(0, limit).map((i) => <InsightItem key={i.id} i={i} compact />)}</div>
      ) : <Empty title="Nothing notable right now">Insights appear when something meaningfully changes or needs your attention.</Empty>}
    </Card>
  );
}

/* --------------------------------- unusual activity --------------------------------- */

const TYPE_LABEL: Record<UnusualActivity["type"], string> = {
  large_transaction: "Large payment",
  frequent_transactions: "Frequent payments",
  merchant_spike: "Merchant spending",
  category_spike: "Category spending",
  unusual_day: "Spending day",
  spending_spike: "Weekly spending",
  possible_duplicate: "Duplicate-looking",
};

export function UnusualActivityTable({ items }: { items: UnusualActivity[] }) {
  if (!items.length) return <Empty title="Nothing unusual">No activity stands out from your normal pattern.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>When</th><th>What</th><th className="n">Observed</th><th className="n hide-sm">Normally</th><th>Severity</th><th className="hide-sm n">Confidence</th></tr></thead>
        <tbody>
          {items.map((a) => (
            <tr key={a.id}>
              <td style={{ whiteSpace: "nowrap" }}>{shortDate(a.date)}</td>
              <td className="desc"><b>{TYPE_LABEL[a.type]}{a.merchant ? ` · ${a.merchant}` : a.category ? ` · ${categoryLabel(a.category)}` : ""}</b><span>{a.reason}</span></td>
              <td className="n">{a.unit === "count" ? `${a.observed} payments` : inr(a.observed)}</td>
              <td className="n hide-sm">{a.baselineLabel.replace(/^typical[^:]*: /, "").replace(/^normally /, "")}</td>
              <td><Badge tone={a.severity === "high" ? "neg" : a.severity === "medium" ? "warn" : undefined}>{a.severity}</Badge></td>
              <td className="n hide-sm">{Math.round(a.confidence * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function UnusualNote() {
  return (
    <p className="faint" style={{ fontSize: 11.5, margin: 0 }}>
      <ShieldQuestion size={12} style={{ verticalAlign: "-2px" }} /> &quot;Unusual&quot; only means different from your own past pattern. It says nothing about whether a payment is right or wrong, and it is worked out with fixed statistics, not by an AI.
    </p>
  );
}
