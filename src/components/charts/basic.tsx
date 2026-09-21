"use client";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ComposedChart, Line, Pie, PieChart, ReferenceLine, ResponsiveContainer, Scatter, ScatterChart, Tooltip, Treemap, XAxis, YAxis, ZAxis,
} from "recharts";
import type { PeriodPoint, CategorySpend, MerchantSpend } from "@/lib/analytics/engine";
import type { ProjectionPoint } from "@/lib/analytics/projection";
import { catColor, categoryLabel, inr, inrCompact, longDate, shortDate } from "@/lib/client/format";
import { parseISO } from "@/lib/util/dates";
import { axisProps, C, ChartEmpty, LegendRow, moneyTick, Tip } from "./shared";

/* ---------------------------- time-series charts ---------------------------- */

/** Q: "Am I earning more than I spend, and how is the gap changing?" */
export function IncomeExpenseChart({ points, height = 300 }: { points: PeriodPoint[]; height?: number }) {
  if (!points.length) return <ChartEmpty />;
  const dense = points.length > 40;
  return (
    <div className="chart-box" role="img" aria-label="Income versus spending over time">
      <LegendRow items={[{ label: "Income", color: C.income }, { label: "Spending", color: C.spending }, { label: "Net cash flow", color: C.net }]} />
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={points} margin={{ left: 0, right: 8, top: 6 }}>
          <CartesianGrid vertical={false} stroke={C.grid} />
          <XAxis dataKey="label" {...axisProps} minTickGap={24} />
          <YAxis {...axisProps} tickFormatter={moneyTick} width={52} />
          <Tooltip content={<Tip />} cursor={{ fill: "var(--surface-2)" }} />
          <ReferenceLine y={0} stroke="var(--border-strong)" />
          {dense ? (
            <>
              <Area dataKey="income" name="Income" stroke={C.income} fill={C.income} fillOpacity={0.14} strokeWidth={2} dot={false} />
              <Area dataKey="spending" name="Spending" stroke={C.spending} fill={C.spending} fillOpacity={0.14} strokeWidth={2} dot={false} />
            </>
          ) : (
            <>
              <Bar dataKey="income" name="Income" fill={C.income} radius={[4, 4, 0, 0]} maxBarSize={28} />
              <Bar dataKey="spending" name="Spending" fill={C.spending} radius={[4, 4, 0, 0]} maxBarSize={28} />
            </>
          )}
          <Line dataKey="netCashFlow" name="Net cash flow" stroke={C.net} strokeWidth={2.2} dot={dense ? false : { r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Q: "How much do I spend day to day, and is there a trend?" (with 7-day moving average) */
export function DailySpendLine({ points, height = 260 }: { points: PeriodPoint[]; height?: number }) {
  if (!points.length) return <ChartEmpty />;
  const withAvg = points.map((p, i) => {
    const w = points.slice(Math.max(0, i - 6), i + 1);
    return { ...p, avg7: Math.round(w.reduce((a, x) => a + x.spending, 0) / w.length) };
  });
  return (
    <div className="chart-box" role="img" aria-label="Daily spending with 7-day average">
      <LegendRow items={[{ label: "Daily spending", color: C.spending }, { label: "7-day average", color: C.amber, dashed: true }]} />
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={withAvg} margin={{ left: 0, right: 8, top: 6 }}>
          <defs>
            <linearGradient id="gSpend" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.spending} stopOpacity={0.35} />
              <stop offset="100%" stopColor={C.spending} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={C.grid} />
          <XAxis dataKey="label" {...axisProps} minTickGap={28} />
          <YAxis {...axisProps} tickFormatter={moneyTick} width={52} />
          <Tooltip content={<Tip title={(l) => l} />} />
          <Area dataKey="spending" name="Spending" stroke={C.spending} fill="url(#gSpend)" strokeWidth={1.6} dot={false} />
          <Line dataKey="avg7" name="7-day avg" stroke={C.amber} strokeDasharray="4 3" strokeWidth={2} dot={false} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Q: "Which weeks/quarters were heavy?" - one bar series, optionally coloured by sign. */
export function PeriodBars({
  points, dataKey, name, color = C.spending, signed, height = 260,
}: { points: PeriodPoint[]; dataKey: keyof PeriodPoint; name: string; color?: string; signed?: boolean; height?: number }) {
  if (!points.length) return <ChartEmpty />;
  return (
    <div className="chart-box" role="img" aria-label={`${name} by period`}>
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={points} margin={{ left: 0, right: 8, top: 6 }}>
          <CartesianGrid vertical={false} stroke={C.grid} />
          <XAxis dataKey="label" {...axisProps} minTickGap={16} />
          <YAxis {...axisProps} tickFormatter={moneyTick} width={52} />
          <Tooltip content={<Tip />} cursor={{ fill: "var(--surface-2)" }} />
          {signed && <ReferenceLine y={0} stroke="var(--border-strong)" />}
          <Bar dataKey={dataKey as string} name={name} radius={[4, 4, 0, 0]} maxBarSize={36}>
            {points.map((p, i) => (
              <Cell key={i} fill={signed ? ((p[dataKey] as number) >= 0 ? C.income : C.spending) : color} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Q: "Am I saving, and is my savings rate improving?" */
export function SavingsTrend({ points, height = 260 }: { points: PeriodPoint[]; height?: number }) {
  const rows = points.filter((p) => p.savingsRate !== null);
  if (!rows.length) return <ChartEmpty>Savings rate needs income in the range</ChartEmpty>;
  return (
    <div className="chart-box" role="img" aria-label="Savings rate by month">
      <LegendRow items={[{ label: "Saved (₹)", color: C.accent }, { label: "Savings rate (%)", color: C.violet }]} />
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={rows} margin={{ left: 0, right: 0, top: 6 }}>
          <CartesianGrid vertical={false} stroke={C.grid} />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis yAxisId="l" {...axisProps} tickFormatter={moneyTick} width={52} />
          <YAxis yAxisId="r" orientation="right" {...axisProps} tickFormatter={(v) => `${v}%`} width={40} />
          <Tooltip content={<Tip format={(v, n) => (n?.includes("rate") ? `${v}%` : inr(v))} />} />
          <ReferenceLine yAxisId="l" y={0} stroke="var(--border-strong)" />
          <Bar yAxisId="l" dataKey="savings" name="Saved" fill={C.accent} radius={[4, 4, 0, 0]} fillOpacity={0.75} maxBarSize={30} />
          <Line yAxisId="r" dataKey="savingsRate" name="Savings rate" stroke={C.violet} strokeWidth={2.2} dot={{ r: 3 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Q: "How is my cash position moving over time?" cumulative net (+ real balance when statements carry it) */
export function CashflowArea({ points, height = 280 }: { points: { date: string; net: number; cumulative: number; balance?: number }[]; height?: number }) {
  if (!points.length) return <ChartEmpty />;
  const hasBalance = points.some((p) => p.balance != null);
  return (
    <div className="chart-box" role="img" aria-label="Cash flow timeline">
      <LegendRow items={[{ label: "Cumulative net cash flow", color: C.net }, ...(hasBalance ? [{ label: "Account balance", color: C.accent, dashed: true }] : [])]} />
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={points} margin={{ left: 0, right: 8, top: 6 }}>
          <defs>
            <linearGradient id="gCash" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={C.net} stopOpacity={0.35} />
              <stop offset="100%" stopColor={C.net} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={C.grid} />
          <XAxis dataKey="date" {...axisProps} tickFormatter={shortDate} minTickGap={40} />
          <YAxis {...axisProps} tickFormatter={moneyTick} width={52} />
          <Tooltip content={<Tip title={(l) => longDate(String(l))} />} />
          <ReferenceLine y={0} stroke="var(--border-strong)" />
          <Area dataKey="cumulative" name="Cumulative net" stroke={C.net} fill="url(#gCash)" strokeWidth={2} dot={false} />
          {hasBalance && <Line dataKey="balance" name="Balance" stroke={C.accent} strokeDasharray="4 3" strokeWidth={1.8} dot={false} connectNulls />}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Q: "How does this month compare with last month, category by category?" */
export function MonthCompareBars({ rows, height = 300, currentLabel = "This month", previousLabel = "Last month" }: { rows: { category: string; current: number; previous: number }[]; height?: number; currentLabel?: string; previousLabel?: string }) {
  const data = rows.slice(0, 8).map((r) => ({ ...r, label: categoryLabel(r.category) }));
  if (!data.length) return <ChartEmpty />;
  return (
    <div className="chart-box" role="img" aria-label="Category spending this month versus last month">
      <LegendRow items={[{ label: currentLabel, color: C.accent }, { label: previousLabel, color: C.slate }]} />
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={data} margin={{ left: 0, right: 8, top: 6 }}>
          <CartesianGrid vertical={false} stroke={C.grid} />
          <XAxis dataKey="label" {...axisProps} interval={0} tick={{ fill: "var(--text-faint)", fontSize: 10 }} />
          <YAxis {...axisProps} tickFormatter={moneyTick} width={52} />
          <Tooltip content={<Tip />} cursor={{ fill: "var(--surface-2)" }} />
          <Bar dataKey="current" name={currentLabel} fill={C.accent} radius={[4, 4, 0, 0]} maxBarSize={22} />
          <Bar dataKey="previous" name={previousLabel} fill={C.slate} radius={[4, 4, 0, 0]} maxBarSize={22} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Q: "How is each category trending?" stacked by month. */
export function CategoryTrendArea({ keys, rows, height = 300 }: { keys: string[]; rows: Record<string, number | string>[]; height?: number }) {
  if (!rows.length) return <ChartEmpty />;
  return (
    <div className="chart-box" role="img" aria-label="Category spending trend">
      <LegendRow items={keys.map((k) => ({ label: categoryLabel(k), color: k === "OTHER CATEGORIES" ? C.slate : catColor(k) }))} />
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={rows} margin={{ left: 0, right: 8, top: 6 }}>
          <CartesianGrid vertical={false} stroke={C.grid} />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis {...axisProps} tickFormatter={moneyTick} width={52} />
          <Tooltip content={<Tip />} />
          {keys.map((k) => (
            <Area key={k} type="monotone" stackId="1" dataKey={k} name={categoryLabel(k)} stroke={k === "OTHER CATEGORIES" ? C.slate : catColor(k)} fill={k === "OTHER CATEGORIES" ? C.slate : catColor(k)} fillOpacity={0.55} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Q: "How often do I transact?" counts by month. */
export function FrequencyChart({ rows, height = 240 }: { rows: { label: string; debits: number; credits: number }[]; height?: number }) {
  if (!rows.length) return <ChartEmpty />;
  return (
    <div className="chart-box" role="img" aria-label="Transaction counts by month">
      <LegendRow items={[{ label: "Outgoing", color: C.spending }, { label: "Incoming", color: C.income }]} />
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={rows} margin={{ left: 0, right: 8, top: 6 }}>
          <CartesianGrid vertical={false} stroke={C.grid} />
          <XAxis dataKey="label" {...axisProps} />
          <YAxis {...axisProps} width={36} allowDecimals={false} />
          <Tooltip content={<Tip format={(v) => `${v}`} />} cursor={{ fill: "var(--surface-2)" }} />
          <Bar dataKey="debits" name="Outgoing" stackId="a" fill={C.spending} maxBarSize={30} />
          <Bar dataKey="credits" name="Incoming" stackId="a" fill={C.income} radius={[4, 4, 0, 0]} maxBarSize={30} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ----------------------------- category / merchant ----------------------------- */

/** Q: "Where does my money go?" donut + ranked legend. */
export function CategoryDonut({ data, height = 230, colorFor = (n: string) => catColor(n), labelFor = categoryLabel, centerLabel = "Total" }: {
  data: { name: string; value: number }[]; height?: number; colorFor?: (name: string) => string; labelFor?: (name: string) => string; centerLabel?: string;
}) {
  const total = data.reduce((a, d) => a + d.value, 0);
  if (!data.length || total <= 0) return <ChartEmpty />;
  const top = data.slice(0, 7);
  const restVal = data.slice(7).reduce((a, d) => a + d.value, 0);
  const shown = restVal > 0 ? [...top, { name: "__rest", value: restVal }] : top;
  const col = (n: string) => (n === "__rest" ? C.slate : colorFor(n));
  const lab = (n: string) => (n === "__rest" ? "Everything else" : labelFor(n));
  return (
    <div className="row" style={{ alignItems: "center", gap: 18, flexWrap: "wrap" }} role="img" aria-label="Breakdown by category">
      <div style={{ width: height, height, position: "relative", flex: "none", margin: "0 auto" }}>
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Tooltip content={<Tip format={(v) => `${inr(v)} · ${((v / total) * 100).toFixed(1)}%`} />} />
            <Pie data={shown} dataKey="value" nameKey="name" innerRadius="64%" outerRadius="94%" paddingAngle={2} stroke="none" cornerRadius={4}>
              {shown.map((d) => (
                <Cell key={d.name} fill={col(d.name)} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", pointerEvents: "none", textAlign: "center" }}>
          <div>
            <div className="faint" style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: ".1em" }}>{centerLabel}</div>
            <div style={{ fontSize: 19, fontWeight: 650 }} className="num">{inrCompact(total)}</div>
          </div>
        </div>
      </div>
      <div className="legend grow" style={{ minWidth: 190 }}>
        {shown.map((d) => (
          <div className="li" key={d.name}>
            <span className="dot" style={{ background: col(d.name) }} />
            <span className="name">{lab(d.name)}</span>
            <span className="v">{inrCompact(d.value)}</span>
            <span className="faint num" style={{ width: 42, textAlign: "right" }}>{((d.value / total) * 100).toFixed(0)}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Q: "Which categories dominate?" horizontal ranked bars. */
export function CategoryBars({ data, height = 300 }: { data: CategorySpend[]; height?: number }) {
  const rows = data.slice(0, 10).map((d) => ({ name: categoryLabel(d.category), value: d.amount, cat: d.category, count: d.count }));
  if (!rows.length) return <ChartEmpty />;
  return (
    <div className="chart-box" role="img" aria-label="Spending by category ranked">
      <ResponsiveContainer width="100%" height={Math.max(height, rows.length * 32)}>
        <BarChart data={rows} layout="vertical" margin={{ left: 0, right: 16, top: 0 }}>
          <CartesianGrid horizontal={false} stroke={C.grid} />
          <XAxis type="number" {...axisProps} tickFormatter={moneyTick} />
          <YAxis type="category" dataKey="name" {...axisProps} width={110} />
          <Tooltip content={<Tip format={(v) => inr(v)} extra={(p) => <div className="tr"><span>Transactions</span><b>{p[0]?.payload?.count}</b></div>} />} cursor={{ fill: "var(--surface-2)" }} />
          <Bar dataKey="value" name="Spent" radius={[0, 5, 5, 0]} maxBarSize={18}>
            {rows.map((r) => (
              <Cell key={r.cat} fill={catColor(r.cat)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function TreeCell(props: any) {
  const { x, y, width, height, name, depth, root, colors } = props;
  if (width < 4 || height < 4) return null;
  const top = depth === 1 ? name : root?.name;
  const fill = colors?.[top] ?? C.slate;
  return (
    <g>
      <rect x={x} y={y} width={width} height={height} rx={4} fill={fill} fillOpacity={depth === 1 ? 0.25 : 0.72} stroke="var(--bg)" strokeWidth={2} />
      {width > 58 && height > 24 && (
        <text x={x + 7} y={y + 16} fill={depth === 1 ? fill : "#fff"} fontSize={depth === 1 ? 11 : 11} fontWeight={depth === 1 ? 700 : 500} style={{ pointerEvents: "none" }}>
          {String(name).length > Math.floor(width / 7) ? String(name).slice(0, Math.floor(width / 7)) + "…" : name}
        </text>
      )}
    </g>
  );
}

/** Q: "Which sub-categories make up each category?" */
export function SubcategoryTreemap({ data, height = 340 }: { data: CategorySpend[]; height?: number }) {
  const tree = data
    .filter((c) => c.amount > 0)
    .slice(0, 9)
    .map((c) => ({ name: categoryLabel(c.category), key: c.category, children: c.subcategories.filter((s) => s.amount > 0).map((s) => ({ name: s.name, size: s.amount })) }));
  if (!tree.length) return <ChartEmpty />;
  const colors = Object.fromEntries(tree.map((t) => [t.name, catColor(t.key)]));
  return (
    <div className="chart-box" role="img" aria-label="Sub-category treemap">
      <ResponsiveContainer width="100%" height={height}>
        <Treemap data={tree} dataKey="size" nameKey="name" stroke="none" isAnimationActive={false} content={<TreeCell colors={colors} />}>
          <Tooltip content={<Tip format={(v) => inr(v)} title={(_, p) => p[0]?.payload?.name} />} />
        </Treemap>
      </ResponsiveContainer>
    </div>
  );
}

/** Q: "Who am I paying the most?" */
export function MerchantBars({ data, height = 280, limit = 8 }: { data: MerchantSpend[]; height?: number; limit?: number }) {
  const rows = data.slice(0, limit).map((d) => ({ name: d.merchant, value: d.amount, cat: d.category, count: d.count, avg: d.average }));
  if (!rows.length) return <ChartEmpty />;
  return (
    <div className="chart-box" role="img" aria-label="Top merchants by spending">
      <ResponsiveContainer width="100%" height={Math.max(height, rows.length * 34)}>
        <BarChart data={rows} layout="vertical" margin={{ left: 0, right: 16, top: 0 }}>
          <CartesianGrid horizontal={false} stroke={C.grid} />
          <XAxis type="number" {...axisProps} tickFormatter={moneyTick} />
          <YAxis type="category" dataKey="name" {...axisProps} width={112} tick={{ fill: "var(--text-dim)", fontSize: 12 }} />
          <Tooltip content={<Tip extra={(p) => <><div className="tr"><span>Payments</span><b>{p[0]?.payload?.count}</b></div><div className="tr"><span>Average</span><b>{inr(p[0]?.payload?.avg)}</b></div></>} />} cursor={{ fill: "var(--surface-2)" }} />
          <Bar dataKey="value" name="Spent" radius={[0, 5, 5, 0]} maxBarSize={18}>
            {rows.map((r, i) => (
              <Cell key={i} fill={catColor(r.cat)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* --------------------------------- patterns --------------------------------- */

/** Q: "How are my transactions sized?" histogram of debit amounts. */
export function DistributionChart({ rows, height = 240 }: { rows: { label: string; count: number; amount: number }[]; height?: number }) {
  if (!rows.some((r) => r.count)) return <ChartEmpty />;
  return (
    <div className="chart-box" role="img" aria-label="Distribution of expense sizes">
      <ResponsiveContainer width="100%" height={height}>
        <BarChart data={rows} margin={{ left: 0, right: 8, top: 6 }}>
          <CartesianGrid vertical={false} stroke={C.grid} />
          <XAxis dataKey="label" {...axisProps} interval={0} tick={{ fill: "var(--text-faint)", fontSize: 10 }} />
          <YAxis {...axisProps} width={36} allowDecimals={false} />
          <Tooltip content={<Tip format={(v, n) => (n === "Total" ? inr(v) : `${v}`)} extra={(p) => <div className="tr"><span>Total</span><b>{inr(p[0]?.payload?.amount ?? 0)}</b></div>} />} cursor={{ fill: "var(--surface-2)" }} />
          <Bar dataKey="count" name="Transactions" fill={C.violet} radius={[4, 4, 0, 0]} maxBarSize={38} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Q: "Where are my big movements, and which ones are outliers?" debit vs credit scatter. */
export function DebitCreditScatter({ points, height = 320 }: { points: { id: string; date: string; amount: number; direction: string; merchant: string; category: string; outlier: boolean }[]; height?: number }) {
  if (!points.length) return <ChartEmpty />;
  const toX = (d: string) => parseISO(d).getTime();
  const debits = points.filter((p) => p.direction === "debit" && !p.outlier).map((p) => ({ ...p, x: toX(p.date), y: p.amount }));
  const credits = points.filter((p) => p.direction === "credit").map((p) => ({ ...p, x: toX(p.date), y: p.amount }));
  const outliers = points.filter((p) => p.outlier).map((p) => ({ ...p, x: toX(p.date), y: p.amount }));
  const tip = ({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const p = payload[0].payload;
    return (
      <div className="tt">
        <div className="th">{p.merchant}</div>
        <div className="tr"><span>Date</span><b>{longDate(p.date)}</b></div>
        <div className="tr"><span>{p.direction === "credit" ? "Received" : "Paid"}</span><b>{inr(p.amount)}</b></div>
        <div className="tr"><span>Category</span><b>{categoryLabel(p.category)}</b></div>
        {p.outlier && <div className="warn" style={{ marginTop: 4, fontSize: 11.5 }}>Statistical outlier</div>}
      </div>
    );
  };
  return (
    <div className="chart-box" role="img" aria-label="Debit versus credit scatter plot">
      <LegendRow items={[{ label: "Debits", color: C.spending }, { label: "Credits", color: C.income }, { label: "Outliers", color: C.amber }]} />
      <ResponsiveContainer width="100%" height={height}>
        <ScatterChart margin={{ left: 0, right: 12, top: 6 }}>
          <CartesianGrid stroke={C.grid} />
          <XAxis type="number" dataKey="x" domain={["dataMin", "dataMax"]} {...axisProps} tickFormatter={(v) => shortDate(new Date(v).toISOString().slice(0, 10))} tickCount={6} />
          <YAxis type="number" dataKey="y" {...axisProps} tickFormatter={moneyTick} width={52} />
          <ZAxis range={[36, 36]} />
          <Tooltip content={tip} cursor={{ strokeDasharray: "3 3" }} />
          <Scatter data={debits} fill={C.spending} fillOpacity={0.6} />
          <Scatter data={credits} fill={C.income} fillOpacity={0.7} />
          <Scatter data={outliers} fill={C.amber} shape="diamond" />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Q: "How does the timing of upcoming bills look?" one bar per day for the horizon. */
export function UpcomingTimeline({ items, from, days = 30 }: { items: { date: string; amount: number; name: string }[]; from: string; days?: number }) {
  const start = parseISO(from).getTime();
  const buckets = Array.from({ length: days }, (_, i) => {
    const d = new Date(start + i * 86400000).toISOString().slice(0, 10);
    const its = items.filter((x) => x.date === d);
    return { date: d, total: its.reduce((a, x) => a + x.amount, 0), items: its };
  });
  const max = Math.max(1, ...buckets.map((b) => b.total));
  return (
    <div role="img" aria-label="Upcoming payments timeline">
      <div style={{ display: "flex", alignItems: "flex-end", gap: 3, height: 92 }}>
        {buckets.map((b) => (
          <div key={b.date} title={b.items.length ? `${longDate(b.date)}\n${b.items.map((i) => `${i.name}: ${inr(i.amount)}`).join("\n")}` : longDate(b.date)} style={{ flex: 1, display: "flex", alignItems: "flex-end", height: "100%" }}>
            <div style={{ width: "100%", height: b.total ? `${Math.max(10, (b.total / max) * 100)}%` : 3, borderRadius: 3, background: b.total ? "var(--est)" : "var(--surface-2)", opacity: b.total ? 0.95 : 1 }} />
          </div>
        ))}
      </div>
      <div className="row spread faint" style={{ fontSize: 11, marginTop: 6 }}>
        <span>{shortDate(buckets[0].date)}</span>
        <span>{shortDate(buckets[Math.floor(days / 2)].date)}</span>
        <span>{shortDate(buckets[days - 1].date)}</span>
      </div>
    </div>
  );
}

/** Q: "Am I on budget?" budget vs actual vs projected month-end (estimate). */
export function BudgetBars({ rows, height = 300 }: { rows: { category: string; budget: number; actual: number; projected: number }[]; height?: number }) {
  if (!rows.length) return <ChartEmpty>No budgets yet</ChartEmpty>;
  const data = rows.map((r) => ({ ...r, label: categoryLabel(r.category) }));
  return (
    <div className="chart-box" role="img" aria-label="Budget versus actual spending">
      <LegendRow items={[{ label: "Budget", color: C.slate }, { label: "Actual", color: C.accent }, { label: "Projected month-end (estimate)", color: C.amber }]} />
      <ResponsiveContainer width="100%" height={Math.max(height, data.length * 60)}>
        <BarChart data={data} layout="vertical" margin={{ left: 0, right: 16, top: 0 }} barGap={2}>
          <CartesianGrid horizontal={false} stroke={C.grid} />
          <XAxis type="number" {...axisProps} tickFormatter={moneyTick} />
          <YAxis type="category" dataKey="label" {...axisProps} width={100} tick={{ fill: "var(--text-dim)", fontSize: 12 }} />
          <Tooltip content={<Tip />} cursor={{ fill: "var(--surface-2)" }} />
          <Bar dataKey="budget" name="Budget" fill={C.slate} fillOpacity={0.45} radius={[0, 4, 4, 0]} maxBarSize={12} />
          <Bar dataKey="actual" name="Actual" fill={C.accent} radius={[0, 4, 4, 0]} maxBarSize={12} />
          <Bar dataKey="projected" name="Projected" fill={C.amber} fillOpacity={0.8} radius={[0, 4, 4, 0]} maxBarSize={12} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Recurring commitments as monthly-equivalent bars. */
export function RecurringBars({ rows, height = 280 }: { rows: { name: string; monthly: number; category: string }[]; height?: number }) {
  if (!rows.length) return <ChartEmpty>No recurring payments detected yet</ChartEmpty>;
  return (
    <div className="chart-box" role="img" aria-label="Recurring payments, monthly equivalent">
      <ResponsiveContainer width="100%" height={Math.max(height, rows.length * 32)}>
        <BarChart data={rows} layout="vertical" margin={{ left: 0, right: 16 }}>
          <CartesianGrid horizontal={false} stroke={C.grid} />
          <XAxis type="number" {...axisProps} tickFormatter={moneyTick} />
          <YAxis type="category" dataKey="name" {...axisProps} width={120} tick={{ fill: "var(--text-dim)", fontSize: 12 }} />
          <Tooltip content={<Tip />} cursor={{ fill: "var(--surface-2)" }} />
          <Bar dataKey="monthly" name="Per month (est.)" radius={[0, 5, 5, 0]} maxBarSize={16}>
            {rows.map((r, i) => (
              <Cell key={i} fill={catColor(r.category)} />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

export function Sparkline({ values, color = C.accent, width = 90, height = 30 }: { values: number[]; color?: string; width?: number; height?: number }) {
  if (values.length < 2) return null;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * width},${height - 3 - ((v - min) / span) * (height - 6)}`).join(" ");
  return (
    <svg width={width} height={height} className="spark" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/**
 * Q: "Where is my balance heading over the next few weeks?"
 * The solid line is the ACTUAL balance from statements; dashed lines are ESTIMATES: the committed line counts only
 * expected income and recurring payments, the amber line also subtracts typical everyday spending (shaded band = range).
 */
export function ProjectionChart({ points, today, height = 280 }: { points: ProjectionPoint[]; today: string; height?: number }) {
  if (!points.some((p) => p.committed !== undefined)) return <ChartEmpty>A projection needs the running balance from your statements.</ChartEmpty>;
  const data = points.map((p) => ({ ...p, band: p.likelyLow !== undefined && p.likelyHigh !== undefined ? [p.likelyLow, p.likelyHigh] : undefined }));
  return (
    <div className="chart-box" role="img" aria-label="Actual balance and projected balance for the next 30 days">
      <LegendRow items={[{ label: "Actual balance", color: C.accent }, { label: "Projected: income and recurring only (estimate)", color: C.net, dashed: true }, { label: "Projected: after typical everyday spending (estimate)", color: C.amber, dashed: true }]} />
      <ResponsiveContainer width="100%" height={height}>
        <ComposedChart data={data} margin={{ left: 0, right: 8, top: 6 }}>
          <CartesianGrid vertical={false} stroke={C.grid} />
          <XAxis dataKey="date" {...axisProps} tickFormatter={shortDate} minTickGap={36} />
          <YAxis {...axisProps} tickFormatter={moneyTick} width={52} domain={["auto", "auto"]} />
          <Tooltip content={<Tip title={(l) => longDate(String(l))} />} />
          <ReferenceLine x={today} stroke="var(--border-strong)" strokeDasharray="2 3" label={{ value: "today", fill: "var(--text-faint)", fontSize: 10, position: "insideTopLeft" }} />
          <Area dataKey="band" name="Everyday spending range" stroke="none" fill={C.amber} fillOpacity={0.12} tooltipType="none" isAnimationActive={false} />
          <Line dataKey="actual" name="Actual balance" stroke={C.accent} strokeWidth={2.2} dot={false} connectNulls />
          <Line dataKey="committed" name="Projected (income & recurring)" stroke={C.net} strokeDasharray="5 4" strokeWidth={1.8} dot={false} connectNulls />
          <Line dataKey="likely" name="Projected (after everyday spending)" stroke={C.amber} strokeDasharray="5 4" strokeWidth={1.8} dot={false} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
