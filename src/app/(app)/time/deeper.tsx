"use client";
import { useState } from "react";
import type { Anomaly, CategorySpend, MerchantSpend, PatternData, PeriodPoint } from "@/lib/analytics/engine";
import {
  CashflowArea, CategoryBars, CategoryDonut, CategoryTrendArea, DailySpendLine, DebitCreditScatter, DistributionChart, FrequencyChart, IncomeExpenseChart, MerchantBars, MonthCompareBars, PeriodBars, SavingsTrend, SubcategoryTreemap,
} from "@/components/charts/basic";
import { CalendarHeatmap, WeekdayHeatmap } from "@/components/charts/heat";
import { Badge, Card, CardSkeleton, Empty, ErrorState, Seg } from "@/components/ui";
import { qs, useApi } from "@/lib/client/api";
import { catColor, categoryLabel, inr, longDate } from "@/lib/client/format";
import { C } from "@/components/charts/shared";
import type { Granularity } from "@/lib/util/dates";

type Tab = "time" | "categories" | "merchants" | "patterns" | "cashflow";
const TABS: { value: Tab; label: string }[] = [
  { value: "time", label: "Over time" },
  { value: "categories", label: "Categories" },
  { value: "merchants", label: "Merchants" },
  { value: "patterns", label: "Patterns" },
  { value: "cashflow", label: "Cash flow" },
];

type Section = Tab;

/** The deeper charts behind the Time lens, for the same window. */
export default function Deeper({ from, to }: { from: string; to: string }) {
  const [tab, setTab] = useState<Tab>("time");
  const f = qs({ from, to });
  return (
    <div className="stack" style={{ gap: 16 }}>
      <Seg label="Deeper charts" value={tab as Section} options={TABS} onChange={setTab} />
      {tab === "time" && <TimeTab f={f} />}
      {tab === "categories" && <CategoriesTab f={f} />}
      {tab === "merchants" && <MerchantsTab f={f} />}
      {tab === "patterns" && <PatternsTab f={f} />}
      {tab === "cashflow" && <CashflowTab f={f} />}
    </div>
  );
}

/* ------------------------------------ time ------------------------------------ */
function TimeTab({ f }: { f: string }) {
  const [g, setG] = useState<Granularity>("monthly");
  const daily = useApi<{ points: PeriodPoint[] }>(`/api/analytics/daily${f}`);
  const weekly = useApi<{ points: PeriodPoint[] }>(`/api/analytics/weekly${f}`);
  const monthly = useApi<{ points: PeriodPoint[] }>(`/api/analytics/monthly${f}`);
  const quarterly = useApi<{ points: PeriodPoint[] }>(`/api/analytics/quarterly${f}`);
  const yearly = useApi<{ points: PeriodPoint[] }>(`/api/analytics/yearly${f}`);
  const err = daily.error || weekly.error || monthly.error || quarterly.error || yearly.error;
  if (err) return <ErrorState error={err} retry={() => { daily.reload(); weekly.reload(); monthly.reload(); quarterly.reload(); yearly.reload(); }} />;
  const sets: Record<Granularity, PeriodPoint[] | undefined> = { daily: daily.data?.points, weekly: weekly.data?.points, monthly: monthly.data?.points, quarterly: quarterly.data?.points, yearly: yearly.data?.points };
  if (!monthly.data) return <div className="grid g2"><CardSkeleton h={300} /><CardSkeleton h={300} /></div>;
  return (
    <div className="grid g2">
      <Card className="span-2" title="Income vs expense" sub="Compare earning and spending at any granularity" right={<Seg label="Granularity" value={g} options={(["daily", "weekly", "monthly", "quarterly", "yearly"] as Granularity[]).map((v) => ({ value: v, label: v[0].toUpperCase() + v.slice(1) }))} onChange={setG} />}>
        <IncomeExpenseChart points={sets[g] ?? []} height={320} />
      </Card>
      <Card title="Daily spending" sub="How much do I spend day to day? (last ~4 months, with 7-day average)"><DailySpendLine points={(sets.daily ?? []).slice(-120)} /></Card>
      <Card title="Weekly spending" sub="Which weeks were heavy? (ISO weeks)"><PeriodBars points={(sets.weekly ?? []).slice(-26)} dataKey="spending" name="Spending" /></Card>
      <Card title="Monthly spending" sub="Is my monthly spending rising or falling?"><PeriodBars points={sets.monthly ?? []} dataKey="spending" name="Spending" color={C.spending} /></Card>
      <Card title="Quarterly cash flow" sub="Net cash flow per quarter (credits − debits)"><PeriodBars points={sets.quarterly ?? []} dataKey="netCashFlow" name="Net cash flow" signed /></Card>
      <Card title="Yearly trend" sub="Income vs spending by year"><IncomeExpenseChart points={sets.yearly ?? []} height={260} /></Card>
      <Card title="Savings trend" sub="Am I keeping more of my income over time?"><SavingsTrend points={sets.monthly ?? []} /></Card>
    </div>
  );
}

/* --------------------------------- categories --------------------------------- */
function CategoriesTab({ f }: { f: string }) {
  const q = useApi<{ categories: CategorySpend[]; trend: { keys: string[]; rows: Record<string, number | string>[] }; monthComparison: { rows: { category: string; current: number; previous: number }[] } }>(`/api/analytics/categories${f}`);
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  if (!q.data) return <div className="grid g2"><CardSkeleton /><CardSkeleton /></div>;
  const { categories, trend, monthComparison } = q.data;
  return (
    <div className="grid g2">
      <Card title="Spending by category" sub="Share of total spending"><CategoryDonut data={categories.map((c) => ({ name: c.category, value: c.amount }))} height={250} /></Card>
      <Card title="Ranked categories" sub="Which categories dominate?"><CategoryBars data={categories} /></Card>
      <Card className="span-2" title="Sub-category treemap" sub="What sits inside each category? Area = amount"><SubcategoryTreemap data={categories} /></Card>
      <Card title="Category trend" sub="How is each category changing month to month?"><CategoryTrendArea keys={trend.keys} rows={trend.rows} /></Card>
      <Card title="This month vs last month" sub="Category-by-category monthly comparison"><MonthCompareBars rows={monthComparison.rows} /></Card>
    </div>
  );
}

/* ---------------------------------- merchants ---------------------------------- */
function MerchantsTab({ f }: { f: string }) {
  const [transfers, setTransfers] = useState(false);
  const q = useApi<{ merchants: MerchantSpend[] }>(`/api/analytics/merchants${f}${f ? "&" : "?"}includeTransfers=${transfers ? 1 : 0}`);
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  if (!q.data) return <CardSkeleton h={340} />;
  const rows = q.data.merchants;
  const max = Math.max(1, ...rows.map((r) => r.amount));
  return (
    <div className="grid g-7-5">
      <Card title="Top merchants" sub="Who am I paying the most?" right={<label className="row" style={{ fontSize: 12.5 }}><input type="checkbox" checked={transfers} onChange={(e) => setTransfers(e.target.checked)} style={{ accentColor: "var(--ink)" }} /> Include transfers to people</label>}>
        <MerchantBars data={rows} limit={14} height={420} />
      </Card>
      <Card flush title="Merchant table" sub="Totals, frequency and averages">
        <div className="table-wrap" style={{ maxHeight: 520, overflow: "auto" }}>
          <table className="table">
            <thead><tr><th>Merchant</th><th className="n">Total</th><th className="n">Txns</th><th className="n">Avg</th></tr></thead>
            <tbody>
              {rows.slice(0, 40).map((m) => (
                <tr key={m.merchant}>
                  <td className="desc"><b>{m.merchant}</b><span>{categoryLabel(m.category)} · last {longDate(m.lastDate)}</span><div className="amt-bar"><i style={{ width: `${(m.amount / max) * 100}%`, background: catColor(m.category) }} /></div></td>
                  <td className="n">{inr(m.amount)}</td><td className="n">{m.count}</td><td className="n">{inr(m.average)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ----------------------------------- patterns ----------------------------------- */
interface PatternsRes {
  patterns: PatternData;
  anomalies: Anomaly[];
  largest: { id: string; date: string; merchant: string; category: string; amount: number; direction: string; isOutlier: boolean }[];
  scatter: { id: string; date: string; amount: number; direction: string; merchant: string; category: string; outlier: boolean }[];
}
function PatternsTab({ f }: { f: string }) {
  const q = useApi<PatternsRes>(`/api/analytics/patterns${f}`);
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  if (!q.data) return <div className="grid g2"><CardSkeleton /><CardSkeleton /></div>;
  const { patterns: p, anomalies, largest, scatter } = q.data;
  const maxL = Math.max(1, ...largest.map((l) => l.amount));
  return (
    <div className="grid g2">
      <Card title="Weekday × month heatmap" sub="Which day of the week do I spend the most?"><WeekdayHeatmap data={p.weekdayByMonth} /></Card>
      <Card title="Calendar heatmap" sub="Which specific days were expensive? (last ~30 weeks)"><CalendarHeatmap days={p.calendar} /></Card>
      <Card title="Expense size distribution" sub="Many small payments or a few big ones?"><DistributionChart rows={p.distribution} /></Card>
      <Card title="Transaction frequency" sub="How often do I transact each month?"><FrequencyChart rows={p.frequency} /></Card>
      <Card className="span-2" title="Debit vs credit scatter" sub="Every large movement over time - outliers highlighted"><DebitCreditScatter points={scatter} /></Card>
      <Card title="Unusual transactions" sub="Statistical outliers versus your normal spending in that category" right={<Badge tone="warn">{anomalies.length}</Badge>}>
        {anomalies.length ? (
          <div className="list">
            {anomalies.slice(0, 8).map((a) => (
              <div className="item" key={a.txn.id}>
                <span className="dot" style={{ background: C.amber }} />
                <div className="grow"><b>{a.txn.merchant}</b><span>{longDate(a.txn.date)} · {a.reason}</span></div>
                <b className="num">{inr(a.txn.amount)}</b>
              </div>
            ))}
          </div>
        ) : <Empty title="Nothing unusual">No statistical outliers in this range.</Empty>}
      </Card>
      <Card flush title="Largest transactions" sub="Biggest money movements in the range">
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Transaction</th><th className="n">Amount</th></tr></thead>
            <tbody>
              {largest.map((l) => (
                <tr key={l.id}>
                  <td className="desc"><b>{l.merchant} {l.isOutlier && <Badge tone="warn">outlier</Badge>}</b><span>{longDate(l.date)} · {categoryLabel(l.category)}</span><div className="amt-bar"><i style={{ width: `${(l.amount / maxL) * 100}%`, background: l.direction === "credit" ? C.income : C.spending }} /></div></td>
                  <td className={`n ${l.direction === "credit" ? "pos" : ""}`}>{l.direction === "credit" ? "+" : "−"}{inr(l.amount)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

/* ----------------------------------- cash flow ----------------------------------- */
function CashflowTab({ f }: { f: string }) {
  const q = useApi<{ timeline: { date: string; net: number; cumulative: number; balance?: number }[]; monthly: PeriodPoint[]; incomeSources: { source: string; amount: number; pct: number }[] }>(`/api/analytics/cashflow${f}`);
  if (q.error) return <ErrorState error={q.error} retry={q.reload} />;
  if (!q.data) return <div className="grid g2"><CardSkeleton /><CardSkeleton /></div>;
  const palette = [C.income, C.net, C.violet, C.amber, C.accent, C.slate];
  return (
    <div className="grid g2">
      <Card className="span-2" title="Cash-flow timeline" sub="Cumulative net cash flow (and real balance when your statements include it)"><CashflowArea points={q.data.timeline} height={320} /></Card>
      <Card title="Net cash flow by month" sub="Credits minus debits"><PeriodBars points={q.data.monthly} dataKey="netCashFlow" name="Net cash flow" signed /></Card>
      <Card title="Savings trend" sub="Saved amount and savings rate"><SavingsTrend points={q.data.monthly} /></Card>
      <Card className="span-2" title="Where the money comes from" sub="Income sources and other credits - not every credit is income">
        <CategoryDonut data={q.data.incomeSources.map((s) => ({ name: s.source, value: s.amount }))} colorFor={(n) => palette[q.data!.incomeSources.findIndex((s) => s.source === n) % palette.length]} labelFor={(n) => n} centerLabel="Credits" />
      </Card>
    </div>
  );
}
