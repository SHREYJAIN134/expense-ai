"use client";
import { ChevronLeft, ChevronRight, MessageCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import CalendarLine from "@/components/calendar-line";
import Onboarding from "@/components/Onboarding";
import { PageTitle, Trace } from "@/components/ll";
import Strip, { StripLegend } from "@/components/strip";
import { ErrorState, Skeleton } from "@/components/ui";
import { qs, useApi } from "@/lib/client/api";
import { catColor, categoryLabel, inr, longDate, shortDate } from "@/lib/client/format";
import { atStart, periodWindow, type PeriodUnit } from "@/lib/client/periods";
import type { TimeLens } from "@/lib/services/timelens";
import Deeper from "./deeper";

interface Overview { hasData: boolean; dataRange: { from: string; to: string; count: number } | null }

const UNITS: { value: PeriodUnit; label: string }[] = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
  { value: "quarter", label: "Quarter" },
  { value: "year", label: "Year" },
  { value: "all", label: "All" },
  { value: "custom", label: "Custom" },
];

const pctText = (p: number | null) => (p === null ? "new" : `${p > 0 ? "+" : ""}${Math.round(p)}%`);

export default function TimePage() {
  const router = useRouter();
  const ov = useApi<Overview>("/api/analytics/overview");
  const settings = useApi<{ settings: { monthStartDay: number } }>("/api/settings");
  const [unit, setUnit] = useState<PeriodUnit>("month");
  const [offset, setOffset] = useState(0);
  const [custom, setCustom] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [deeper, setDeeper] = useState(false);

  const range = ov.data?.dataRange ?? null;
  const msd = settings.data?.settings.monthStartDay ?? 1;
  const win = useMemo(() => (range ? periodWindow(unit, offset, range.to, range.from, msd, custom.from && custom.to ? custom : undefined) : null), [unit, offset, range, msd, custom]);
  const lens = useApi<{ lens: TimeLens | null }>(win && win.from <= win.to ? `/api/analytics/time${qs({ from: win.from, to: win.to, label: win.label })}` : null);

  if (ov.error) return <ErrorState error={ov.error} retry={ov.reload} />;
  if (ov.loading && !ov.data) return <div className="stack"><Skeleton h={50} w={220} /><Skeleton h={260} /></div>;
  if (!ov.data?.hasData || !range || !win) return <Onboarding onLoaded={ov.reload} />;

  const L = lens.data?.lens ?? null;
  const st = L?.strip;
  const sp = L?.spending;
  const cats = (sp?.categories ?? []).filter((c) => c.amount > 0);
  const catMax = Math.max(1, ...cats.map((c) => c.amount));
  const cmp = unit !== "all" && unit !== "custom" ? L?.hasPrevious : L?.hasPrevious;
  const goDay = (day: string) => router.push(`/ledger?from=${day}&to=${day}`);
  const net = st ? st.totals.net : 0;
  // Refunds are netted inside "spent", so they reappear here as the gap between money out and spent + moved.
  const refundGap = st ? Math.round((st.totals.in - st.totals.net - st.totals.spend - st.totals.moved) * 100) / 100 : 0;
  const rangeQs = win ? `from=${win.from}&to=${win.to}` : "";
  const step = (n: number) => setOffset((o) => Math.max(0, o + n));
  const canBack = !atStart(win, range.from) && unit !== "all" && unit !== "custom";

  return (
    <div className="fade-in">
      <PageTitle lab="Lens" title="Time">
        <span className="seg" role="tablist" aria-label="Period">
          {UNITS.map((u) => (
            <button key={u.value} role="tab" aria-selected={unit === u.value} className={unit === u.value ? "on" : ""} onClick={() => { setUnit(u.value); setOffset(0); }}>{u.label}</button>
          ))}
        </span>
        {unit !== "all" && unit !== "custom" && (
          <span className="row" style={{ gap: 8 }}>
            <button className="icon-btn" style={{ width: 36, height: 36 }} onClick={() => step(1)} disabled={!canBack} aria-label="Previous period"><ChevronLeft /></button>
            <b className="serif" style={{ fontSize: 20, minWidth: 96, textAlign: "center" }}>{win.label}</b>
            <button className="icon-btn" style={{ width: 36, height: 36 }} onClick={() => step(-1)} disabled={offset === 0} aria-label="Next period"><ChevronRight /></button>
          </span>
        )}
        {unit === "all" && <b className="serif" style={{ fontSize: 20 }}>{shortDate(range.from)} → {longDate(range.to)}</b>}
        {unit === "custom" && (
          <span className="row wrap" style={{ gap: 8 }}>
            <input className="input" type="date" style={{ width: 150 }} value={custom.from} min={range.from} max={range.to} onChange={(e) => setCustom((c) => ({ ...c, from: e.target.value }))} aria-label="From" />
            <span className="faint">→</span>
            <input className="input" type="date" style={{ width: 150 }} value={custom.to} min={range.from} max={range.to} onChange={(e) => setCustom((c) => ({ ...c, to: e.target.value }))} aria-label="To" />
          </span>
        )}
        <span className="chip static" title={cmp ? `Compared with ${sp?.periods.previous.label}` : "Needs an earlier statement"}>
          Compare: previous period · <span className="faint">{L ? (cmp ? "shown" : "no earlier data yet") : "…"}</span>
        </span>
      </PageTitle>

      {lens.error ? <ErrorState error={lens.error} retry={lens.reload} /> : (
        <>
          <div style={{ borderTop: "1px solid var(--hair)", paddingTop: 8 }}>
            <div className="row spread wrap">
              <span className="lab">{win.label} · every day · {st ? `${st.totals.count} events` : "…"}</span>
              <span className="faint" style={{ fontSize: 12.5 }}>Tap a day to open its transactions</span>
            </div>
            <div style={{ marginTop: 6 }}>
              {!st ? <Skeleton h={232} /> : st.days.length === 0 ? <p className="faint" style={{ padding: "24px 0" }}>No transactions in this period.</p> : <Strip data={st} height={240} showEstimate={false} onSelectDay={goDay} />}
            </div>
            <div style={{ marginTop: 10 }}><StripLegend estimate={false} /></div>
          </div>

          <div className="time-grid" style={{ display: "grid", gridTemplateColumns: "minmax(300px,392px) minmax(0,1fr) minmax(280px,372px)", gap: 44, marginTop: 24 }}>
            <div style={{ minWidth: 0 }}>
              <div className="lab">Calendar — shade is spend, dots are events</div>
              <div style={{ marginTop: 8 }}>{st ? <CalendarLine days={st.days} onSelect={goDay} /> : <Skeleton h={200} />}</div>
              <div className="faint" style={{ fontSize: 12.5, marginTop: 2 }}>The ringed day was the priciest.</div>
              <div className="lab" style={{ marginTop: 22 }}>Top merchants</div>
              <table className="table" style={{ marginTop: 4 }}>
                <thead><tr><th>Merchant</th><th className="n">Visits</th><th className="n">Spent</th></tr></thead>
                <tbody>
                  {(sp?.merchants ?? []).slice(0, 5).map((m) => (
                    <tr key={m.key} className="clickable" onClick={() => router.push(`/ledger?merchant=${encodeURIComponent(m.key)}&${rangeQs}`)}>
                      <td><b>{m.key}</b></td><td className="n mono">{m.count}</td><td className="n mono">{inr(m.amount)}</td>
                    </tr>
                  ))}
                  {sp && sp.merchants.length === 0 && <tr><td colSpan={3} className="faint">No merchant spending in this period.</td></tr>}
                </tbody>
              </table>
            </div>

            <div style={{ minWidth: 0 }}>
              <div className="row spread"><span className="lab">Categories{cmp ? ` — vs ${sp?.periods.previous.label.toLowerCase()}` : ""}</span><span className="faint" style={{ fontSize: 12.5 }}>excludes transfers to people</span></div>
              <div style={{ marginTop: 6 }}>
                {!sp ? <Skeleton h={220} /> : cats.length === 0 ? <p className="faint" style={{ padding: "16px 0" }}>No spending in this period.</p> : cats.slice(0, 7).map((c) => {
                  const chg = c.previousAmount > 0 ? ((c.amount - c.previousAmount) / c.previousAmount) * 100 : null;
                  return (
                    <Link key={c.key} href={`/ledger?category=${encodeURIComponent(c.key)}&${rangeQs}`} style={{ display: "grid", gridTemplateColumns: "minmax(90px,130px) 1fr 84px 70px", gap: 14, alignItems: "center", padding: "11px 0", borderTop: "1px solid var(--hair2)" }}>
                      <span className="row" style={{ gap: 8 }}><i className="dot" style={{ background: catColor(c.key), borderRadius: 2 }} />{categoryLabel(c.key)}</span>
                      <span style={{ display: "block", height: 8, borderRadius: 4, background: "var(--soft)", position: "relative" }}><i style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(c.amount / catMax) * 100}%`, background: catColor(c.key), borderRadius: 4 }} /></span>
                      <span className="mono" style={{ textAlign: "right" }}>{inr(c.amount)}</span>
                      <span className={`mono ${cmp && chg !== null ? (chg > 0 ? "out" : "in") : "faint"}`} style={{ textAlign: "right", fontSize: 12 }}>{cmp ? pctText(chg) : `${Math.round(c.pctOfSpending)}%`}</span>
                    </Link>
                  );
                })}
              </div>
              <div className="sheet" style={{ marginTop: 22, padding: "16px 18px" }}>
                <div className="lab">Money in / out this period</div>
                <div className="time-io" style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14, marginTop: 10 }}>
                  <div><div className="serif in" style={{ fontSize: 28 }}>{st ? inr(st.totals.in) : "—"}</div><div className="faint" style={{ fontSize: 12.5 }}>in · {L?.moneyIn.count ?? 0} events</div></div>
                  <div><div className="serif out" style={{ fontSize: 28 }}>{st ? inr(st.totals.spend) : "—"}</div><div className="faint" style={{ fontSize: 12.5 }}>spent{sp ? ` · ${sp.totals.current.spendingCount} events` : ""}</div></div>
                  <div><div className="serif" style={{ fontSize: 28, boxShadow: "inset 0 -2px 0 var(--out)", display: "inline-block" }}>{st ? inr(st.totals.moved) : "—"}</div><div className="faint" style={{ fontSize: 12.5 }}>moved, not spent</div></div>
                </div>
                <div className="row" style={{ marginTop: 12, borderTop: "1px solid var(--hair)", paddingTop: 10 }}>
                  <span className="dim">Net cash flow</span><span style={{ flex: 1 }} />
                  <Trace title="Net cash flow" lines={[`${inr(st?.totals.in ?? 0)} in (all credits)`, `− ${inr(st?.totals.spend ?? 0)} spent`, `− ${inr(st?.totals.moved ?? 0)} moved out`, ...(refundGap > 0 ? [`− ${inr(refundGap)} of purchases later refunded (already netted in spent)`] : []), `= ${inr(net, { sign: true })}  credits − debits`]} href={`/ledger?${rangeQs}`}><b className="mono">{inr(net, { sign: true })}</b></Trace>
                </div>
              </div>
              {sp && sp.changes.categories.length > 0 && cmp && (
                <p className="dim" style={{ fontSize: 13, marginTop: 14 }}>
                  Biggest change: <b>{categoryLabel(sp.changes.categories[0].key)}</b> {sp.changes.categories[0].delta > 0 ? "up" : "down"} {inr(Math.abs(sp.changes.categories[0].delta))} vs {sp.periods.previous.label.toLowerCase()}.
                </p>
              )}
              {sp && sp.caveats.length > 0 && <p className="faint" style={{ fontSize: 12, marginTop: 8 }}>{sp.caveats[0]}</p>}
            </div>

            <div style={{ minWidth: 0 }}>
              <div className="lab">Records — the questions people ask most</div>
              <div style={{ marginTop: 6 }}>
                <Record label="Busiest days" value={L && L.records.busiest.best ? `${L.records.busiest.best} events${L.records.busiest.days.length > 1 ? " each" : ""}` : "—"} days={L?.records.busiest.days.map((d) => d.date)} note={L && L.records.busiest.days.length > 1 ? `${L.records.busiest.days.length} days tie — all shown` : undefined} />
                <Record label="Priciest day" value={L && L.records.priciest.best ? inr(L.records.priciest.best) : "—"} days={L?.records.priciest.days.map((d) => d.date)} note={L && L.records.priciest.days.length > 1 ? "days tie — all shown" : undefined} />
                <Record label="Most money in" value={L && L.records.mostIn.best ? inr(L.records.mostIn.best) : "—"} days={L?.records.mostIn.days.map((d) => d.date)} note="includes transfers received" />
                <div style={{ padding: "14px 0", borderTop: "1px solid var(--hair)" }}>
                  <div className="lab">Largest single transaction</div>
                  <div className="row spread" style={{ alignItems: "baseline", marginTop: 4 }}>
                    <span className="serif" style={{ fontSize: 28, letterSpacing: "-.02em" }}>{L?.records.largest ? inr(L.records.largest.amount) : "—"}</span>
                    {L?.records.largest && <Link className="chip on" href={`/ledger?open=${L.records.largest.id}&from=${L.records.largest.date}&to=${L.records.largest.date}`}>{shortDate(L.records.largest.date)}</Link>}
                  </div>
                  {L?.records.largest && <div className="faint" style={{ fontSize: 12.5, marginTop: 4 }}>{L.records.largest.direction === "credit" ? "credit" : "debit"} · {L.records.largest.merchant}{L.records.largest.ties > 1 ? ` · ${L.records.largest.ties} tie` : ""}</div>}
                </div>
              </div>
              <Link href={`/ask?q=${encodeURIComponent(`Why did my spending change in ${win.label}?`)}`} className="btn" style={{ marginTop: 14, width: "100%" }}><MessageCircle /> Ask about this period</Link>
            </div>
          </div>

          <div style={{ marginTop: 34, borderTop: "1px solid var(--hair)", paddingTop: 16 }}>
            <button className="btn ghost sm" onClick={() => setDeeper((v) => !v)} aria-expanded={deeper}>{deeper ? "Hide" : "Show"} deeper charts</button>
            {deeper && <div style={{ marginTop: 16 }}><Deeper from={win.from} to={win.to} /></div>}
          </div>
        </>
      )}
    </div>
  );
}

function Record({ label, value, days, note }: { label: string; value: string; days?: string[]; note?: string }) {
  return (
    <div style={{ padding: "14px 0", borderTop: "1px solid var(--hair)" }}>
      <div className="lab">{label}</div>
      <div className="row spread" style={{ alignItems: "baseline", marginTop: 4, gap: 10 }}>
        <span className="serif" style={{ fontSize: 28, letterSpacing: "-.02em" }}>{value}</span>
        <span className="row wrap" style={{ gap: 5, justifyContent: "flex-end", maxWidth: 210 }}>
          {(days ?? []).slice(0, 6).map((d) => <Link key={d} className="chip on" href={`/ledger?from=${d}&to=${d}`}>{shortDate(d)}</Link>)}
        </span>
      </div>
      {note && <div className="faint" style={{ fontSize: 12.5, marginTop: 4 }}>{note}</div>}
    </div>
  );
}
