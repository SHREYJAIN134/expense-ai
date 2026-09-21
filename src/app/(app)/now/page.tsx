"use client";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import type { SpendingIntelligence } from "@/lib/analytics/compare";
import type { UnusualActivity } from "@/lib/analytics/anomalies";
import type { IntelInsight } from "@/lib/analytics/intelligence";
import type { UpcomingItem } from "@/lib/analytics/planning";
import Onboarding from "@/components/Onboarding";
import { EstTag, SafeToSpendBlock, Trace } from "@/components/ll";
import Strip, { StripLegend } from "@/components/strip";
import { Badge, ErrorState, Skeleton } from "@/components/ui";
import { qs, useApi } from "@/lib/client/api";
import { catColor, categoryLabel, inr, longDate, shortDate } from "@/lib/client/format";
import { buildSignals, topSignals } from "@/lib/client/signals";
import type { StripData } from "@/lib/services/strip";

interface Overview {
  hasData: boolean;
  hasDemo: boolean;
  dataRange: { from: string; to: string; count: number } | null;
  asOf: string;
  balance: { balance: number; asOf: string } | null;
  upcoming: UpcomingItem[];
}

type View = "week" | "month" | "quarter";
const VIEWS: { value: View; label: string }[] = [
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
];

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const weekday = (iso: string) => new Date(iso + "T00:00:00Z").toLocaleDateString("en-IN", { weekday: "short", timeZone: "UTC" });

export default function NowPage() {
  const router = useRouter();
  const [view, setView] = useState<View>("month");
  const ov = useApi<Overview>("/api/analytics/overview");
  const strip = useApi<{ strip: StripData | null }>(ov.data?.hasData ? `/api/analytics/strip${qs({ view })}` : null);
  const through = ov.data?.dataRange?.to;
  const spending = useApi<SpendingIntelligence>(through ? `/api/intelligence/spending${qs({ period: "month", asOf: through })}` : null);
  const anomalies = useApi<{ anomalies: UnusualActivity[] }>(ov.data?.hasData ? "/api/intelligence/anomalies?days=45" : null);
  const insights = useApi<{ insights: IntelInsight[] }>(ov.data?.hasData ? "/api/intelligence/insights" : null);
  const review = useApi<{ total: number }>(ov.data?.hasData ? "/api/transactions?lowConfidence=1&pageSize=1" : null);

  const signals = useMemo(() => buildSignals(anomalies.data?.anomalies ?? [], insights.data?.insights ?? []), [anomalies.data, insights.data]);
  const margin = useMemo(() => topSignals(signals, 4), [signals]);

  if (ov.error) return <ErrorState error={ov.error} retry={ov.reload} />;
  if (ov.loading && !ov.data) return <NowSkeleton />;
  const d = ov.data;
  if (!d) return null;
  if (!d.hasData) return <Onboarding onLoaded={ov.reload} />;

  const s = strip.data?.strip ?? null;
  const fresh = !!s && s.staleDays <= 1;
  const bal = d.balance;
  const periodWord = !s ? "" : view === "week" ? "the last 7 days" : view === "quarter" ? "the last 90 days" : s.from.endsWith("-01") ? MONTHS[Number(s.from.slice(5, 7)) - 1] : `${shortDate(s.from)} – ${shortDate(s.to)}`;
  const winLines = s ? [`Window: ${longDate(s.from)} → ${longDate(s.to)}`, `${s.totals.count} canonical events (a payment seen in two statements counts once)`] : [];
  const rangeQs = s ? `from=${s.from}&to=${s.to}` : "";
  const cats = (spending.data?.categories ?? []).filter((c) => c.amount > 0);
  const catTotal = cats.reduce((a, c) => a + c.amount, 0) || 1;
  const upcoming = (d.upcoming ?? []).filter((u) => u.kind === "expense").slice(0, 4);
  const reviewN = review.data?.total ?? 0;

  return (
    <div className="fade-in">
      {s && s.staleDays > 3 && (
        <div className="stale-banner" style={{ marginBottom: 18 }} role="status">
          <div className="row spread wrap" style={{ gap: 12 }}>
            <div>
              <b>Your data is {s.staleDays} days behind.</b>
              <div className="dim" style={{ fontSize: 13, marginTop: 2 }}>The newest transaction is from {longDate(s.dataThrough ?? s.to)}. Balance, safe to spend and projections are as of that day, and everything after it is an estimate.</div>
            </div>
            <Link href="/bring-in" className="btn solid sm">Bring in a newer statement</Link>
          </div>
        </div>
      )}

      <div className="now-grid" style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 380px", gap: 52 }}>
        <div style={{ minWidth: 0 }}>
          <div className="lab">
            {s ? `${weekday(s.dataThrough ?? s.to)} ${longDate(s.dataThrough ?? s.to)}` : "…"} · all sources · {d.dataRange?.count.toLocaleString("en-IN")} events
            {d.hasDemo && <> · <Badge tone="demo">DEMO DATA</Badge></>}
          </div>

          {!s ? (
            <div style={{ marginTop: 14 }}><Skeleton h={120} /></div>
          ) : (
            <h1 className="headline wide" style={{ marginTop: 12 }}>
              {bal ? (
                <>
                  {fresh ? "You have " : `On ${shortDate(bal.asOf)} you had `}
                  <Trace title="Balance" lines={[`Balance printed on the statement: ${inr(bal.balance)}`, `As of ${longDate(bal.asOf)} — the last row that carries a balance`, "Read from your statements, not estimated"]} href={`/ledger?to=${bal.asOf}`}>
                    <b>{inr(bal.balance)}</b>
                  </Trace>
                  {" "}in the bank.{" "}
                </>
              ) : null}
              In {periodWord} you spent{" "}
              <Trace title="Spent" lines={[...winLines, "Spent = debits that are not transfers or investments, net of refunds"]} href={`/ledger?${rangeQs}&direction=debit`}><b>{inr(s.totals.spend)}</b></Trace>
              {", took in "}
              <Trace title="Money in" lines={[...winLines, "Money in = every credit: income, refunds, transfers received, other"]} href={`/ledger?${rangeQs}&direction=credit`}><b>{inr(s.totals.in)}</b></Trace>
              {s.totals.moved > 0 && (
                <>
                  {" and moved "}
                  <Trace title="Moved, not spent" lines={[...winLines, "Moved = transfers and investments sent out. It leaves your balance but is not spending."]} href={`/ledger?${rangeQs}&category=TRANSFERS`}><b>{inr(s.totals.moved)}</b></Trace>
                  {" out"}
                </>
              )}
              .
            </h1>
          )}

          <div style={{ marginTop: 16 }}><StripLegend estimate={!!s?.estimate} /></div>

          <div style={{ marginTop: 20, borderTop: "1px solid var(--hair)", paddingTop: 12 }}>
            <div className="row spread wrap">
              <span className="lab">The Strip{s ? ` · ${shortDate(s.from)} → ${s.estimate ? "estimate" : shortDate(s.to)}` : ""}</span>
              <span className="seg" role="tablist" aria-label="Strip window">
                {VIEWS.map((v) => (
                  <button key={v.value} role="tab" aria-selected={view === v.value} className={view === v.value ? "on" : ""} onClick={() => setView(v.value)}>{v.label}</button>
                ))}
              </span>
            </div>
            <div style={{ marginTop: 6 }}>
              {strip.error ? <ErrorState error={strip.error} retry={strip.reload} /> : !s ? <Skeleton h={280} /> : <Strip data={s} onSelectDay={(day) => router.push(`/ledger?from=${day}&to=${day}`)} />}
            </div>
            <div className="faint" style={{ fontSize: 12.5, marginTop: 4 }}>Tap or click a day to open its transactions.</div>
          </div>

          <div className="now-trio" style={{ display: "grid", gridTemplateColumns: "1.15fr 1fr 1fr", marginTop: 14, borderTop: "1px solid var(--hair)" }}>
            <div style={{ padding: "16px 22px 0 0" }}><SafeToSpendBlock /></div>
            <div style={{ padding: "16px 22px 0", borderLeft: "1px solid var(--hair)" }} className="trio-mid">
              <span className="lab">Coming up</span>
              {upcoming.length === 0 ? (
                <p className="faint" style={{ marginTop: 12, fontSize: 13 }}>Nothing expected. Recurring payments appear once a payment repeats.</p>
              ) : (
                upcoming.map((u) => (
                  <div key={u.id} className="row spread" style={{ marginTop: 12, alignItems: "flex-start" }}>
                    <span>
                      <b>{u.name}</b>
                      <div className="faint" style={{ fontSize: 12 }}>{shortDate(u.date)} · {u.source === "manual" ? "you entered it" : `pattern · ${u.confidence.toLowerCase()} confidence`}{u.overdue ? " · may be late" : ""}</div>
                    </span>
                    <span className="mono estc">{inr(u.amount)}</span>
                  </div>
                ))
              )}
              <div className="faint" style={{ fontSize: 12, marginTop: 12 }}>Dates and amounts are expected, not guaranteed. <EstTag /></div>
            </div>
            <div style={{ padding: "16px 0 0 22px", borderLeft: "1px solid var(--hair)" }} className="trio-last">
              <span className="lab">Where it went</span>
              {!spending.data ? <div style={{ marginTop: 12 }}><Skeleton h={90} /></div> : cats.length === 0 ? (
                <p className="faint" style={{ marginTop: 12, fontSize: 13 }}>No spending in this month yet.</p>
              ) : (
                <>
                  <div style={{ display: "flex", gap: 2, height: 14, marginTop: 12 }} role="img" aria-label="Spending share by category">
                    {cats.slice(0, 6).map((c) => <i key={c.key} style={{ flex: c.amount / catTotal, background: catColor(c.key), borderRadius: 3, minWidth: 2 }} />)}
                  </div>
                  <div style={{ marginTop: 8, fontSize: 13.5 }}>
                    {cats.slice(0, 4).map((c) => (
                      <Link key={c.key} href={`/ledger?category=${encodeURIComponent(c.key)}&${rangeQs}`} className="row spread" style={{ padding: "5px 0" }}>
                        <span className="row" style={{ gap: 8 }}><i className="dot" style={{ background: catColor(c.key), borderRadius: 2 }} />{categoryLabel(c.key)}</span>
                        <span className="mono">{inr(c.amount)}</span>
                      </Link>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </div>

        <aside style={{ borderLeft: "1px solid var(--hair)", paddingLeft: 32 }} className="now-aside">
          <div className="row spread">
            <h2 className="serif" style={{ fontSize: 24, fontWeight: 500, fontStyle: "italic" }}>In the margin</h2>
            <span className="faint" style={{ fontSize: 12.5 }}>evidence-based</span>
          </div>
          <div style={{ marginTop: 8 }}>
            {!anomalies.data && !insights.data ? <Skeleton h={160} /> : margin.length === 0 ? (
              <p className="faint" style={{ padding: "16px 0", borderTop: "1px solid var(--hair)" }}>Nothing stands out right now. Signals appear when something meaningfully changes.</p>
            ) : (
              margin.map((m, i) => (
                <div key={m.id} className={i > 0 ? "hide-md" : ""} style={{ padding: "16px 0", borderTop: "1px solid var(--hair)" }}>
                  <div className="row" style={{ gap: 8 }}>
                    <span className="lab">{m.kind}</span>
                    {m.highlight && <span className="dot" style={{ background: "var(--hl)", width: 9, height: 9, border: "1.5px solid var(--ink)" }} aria-label="Worth your eye" />}
                  </div>
                  <p className="serif" style={{ fontSize: 17.5, lineHeight: 1.35, marginTop: 6 }}>{m.highlight ? <span className="hl">{m.title}</span> : m.title}</p>
                  <div className="row spread" style={{ marginTop: 8 }}>
                    <span className="faint" style={{ fontSize: 12.5 }}>{shortDate(m.date)}{m.confidence !== null ? ` · confidence ${Math.round(m.confidence * 100)}%` : ""}</span>
                    <Link href={m.href} className="row" style={{ gap: 4, fontWeight: 600, fontSize: 13 }}>See rows <ChevronRight size={14} /></Link>
                  </div>
                </div>
              ))
            )}
            {signals.length > 0 && (
              <Link href="/signals" className="row spread" style={{ padding: "12px 0", borderTop: "1px solid var(--hair)", fontWeight: 600, fontSize: 13.5 }}>
                <span>{signals.length} signal{signals.length === 1 ? "" : "s"} in total</span><span className="row" style={{ gap: 4 }}>Review <ChevronRight size={14} /></span>
              </Link>
            )}
          </div>
          <div style={{ borderTop: "1px solid var(--ink)", marginTop: 2, paddingTop: 16 }}>
            <div className="lab">Needs your eye</div>
            {review.data ? (
              reviewN > 0 ? (
                <>
                  <div className="row spread" style={{ marginTop: 10, alignItems: "flex-start" }}>
                    <span><b>{reviewN} payment{reviewN === 1 ? "" : "s"}</b> to classify<div className="faint" style={{ fontSize: 12.5 }}>low-confidence categories — you decide what they were</div></span>
                    <Link className="btn sm" href="/ledger?lowConfidence=1">Review</Link>
                  </div>
                  <div style={{ height: 6, borderRadius: 3, background: "var(--soft)", marginTop: 12 }}><i style={{ display: "block", height: 6, borderRadius: 3, width: `${Math.min(100, (reviewN / Math.max(1, d.dataRange?.count ?? 1)) * 100)}%`, background: "var(--ink)" }} /></div>
                </>
              ) : <p className="faint" style={{ marginTop: 8, fontSize: 13.5 }}>Everything is classified with good confidence.</p>
            ) : <Skeleton h={40} style={{ marginTop: 10 }} />}
          </div>
        </aside>
      </div>
    </div>
  );
}

function NowSkeleton() {
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Skeleton h={14} w={260} />
      <Skeleton h={110} />
      <Skeleton h={280} />
    </div>
  );
}
