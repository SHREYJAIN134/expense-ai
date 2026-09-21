"use client";
import { inr, inrCompact, longDate } from "@/lib/client/format";
import { WEEKDAY_SHORT, addDays, isoWeekday, weekStart, type ISODate } from "@/lib/util/dates";
import { ChartEmpty } from "./shared";

const shade = (v: number, max: number) => {
  if (v <= 0 || max <= 0) return "var(--surface-2)";
  const t = Math.pow(v / max, 0.55); // sqrt-ish so mid values remain visible
  return `rgba(251, 113, 133, ${0.14 + t * 0.78})`;
};

function Scale({ max }: { max: number }) {
  return (
    <div className="row faint" style={{ gap: 6, fontSize: 11, marginTop: 10 }}>
      Less
      {[0.1, 0.3, 0.55, 0.8, 1].map((t) => (
        <span key={t} style={{ width: 16, height: 10, borderRadius: 3, background: shade(max * t, max) }} />
      ))}
      More
    </div>
  );
}

/** Q: "Which day of the week do I overspend on?" weekday x month heatmap. */
export function WeekdayHeatmap({ data }: { data: { months: string[]; monthLabels: string[]; cells: { weekday: number; month: string; amount: number }[]; max: number } }) {
  if (!data.months.length) return <ChartEmpty />;
  const map = new Map(data.cells.map((c) => [`${c.weekday}|${c.month}`, c.amount]));
  return (
    <div role="img" aria-label="Spending heatmap by weekday and month">
      <div className="heat" style={{ gridTemplateColumns: `38px repeat(${data.months.length}, minmax(0, 1fr))` }}>
        <div />
        {data.monthLabels.map((m, i) => (
          <div key={i} className="heat-label" style={{ justifyContent: "center", fontSize: 10 }}>
            {m.split(" ")[0]}
          </div>
        ))}
        {WEEKDAY_SHORT.map((w, wi) => (
          <div key={w} style={{ display: "contents" }}>
            <div className="heat-label">{w}</div>
            {data.months.map((m) => {
              const v = map.get(`${wi + 1}|${m}`) ?? 0;
              return (
                <div key={m} className="cell" style={{ background: shade(v, data.max), minHeight: 26 }} title={`${w}, ${m}: ${inr(v)}`}>
                  {v > 0 && data.months.length <= 10 && (
                    <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", fontSize: 9.5, color: v / data.max > 0.5 ? "#fff" : "var(--text-dim)" }}>{inrCompact(v).replace("₹", "")}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <Scale max={data.max} />
    </div>
  );
}

/** Q: "Which specific days were expensive?" GitHub-style calendar of daily spending. */
export function CalendarHeatmap({ days, weeks = 30 }: { days: { date: ISODate; amount: number; count: number }[]; weeks?: number }) {
  if (!days.length) return <ChartEmpty />;
  const last = days[days.length - 1].date;
  const endWeek = weekStart(last);
  const startWeek = addDays(endWeek, -(weeks - 1) * 7);
  const map = new Map(days.map((d) => [d.date, d]));
  const max = Math.max(...days.filter((d) => d.date >= startWeek).map((d) => d.amount), 1);
  const cols: ISODate[][] = [];
  for (let w = 0; w < weeks; w++) {
    const s = addDays(startWeek, w * 7);
    cols.push(Array.from({ length: 7 }, (_, i) => addDays(s, i)));
  }
  return (
    <div role="img" aria-label="Calendar heatmap of daily spending" style={{ overflowX: "auto" }}>
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${weeks}, 14px)`, gridTemplateRows: "repeat(7, 14px)", gridAutoFlow: "column", gap: 3, width: "max-content" }}>
        {cols.flat().map((d) => {
          const v = map.get(d);
          const future = d > last;
          return (
            <div
              key={d}
              className="cell"
              style={{ width: 14, height: 14, minHeight: 0, borderRadius: 3, background: future ? "transparent" : shade(v?.amount ?? 0, max) }}
              title={future ? "" : `${longDate(d)} (${WEEKDAY_SHORT[isoWeekday(d) - 1]}): ${v ? `${inr(v.amount)} · ${v.count} txn` : "no spending"}`}
            />
          );
        })}
      </div>
      <Scale max={max} />
    </div>
  );
}
