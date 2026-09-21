"use client";
/** Calendar heat: shade = money spent that day, dots = number of events, ring = the priciest day. */
import { useMemo } from "react";
import type { StripDay } from "@/lib/services/strip";
import { addDays, parseISO, weekStart } from "@/lib/util/dates";
import { inrCompact, longDate } from "@/lib/client/format";

export default function CalendarLine({ days, onSelect, cell = 40, gap = 6 }: { days: StripDay[]; onSelect?: (date: string) => void; cell?: number; gap?: number }) {
  const geo = useMemo(() => {
    if (!days.length) return null;
    const first = weekStart(days[0].date);
    const last = days[days.length - 1].date;
    const map = new Map(days.map((d) => [d.date, d]));
    const spanDays = Math.round((parseISO(last).getTime() - parseISO(first).getTime()) / 86400000) + 1;
    const weeks = Math.ceil(spanDays / 7);
    const mx = Math.max(1, ...days.map((d) => d.spend));
    const top = days.reduce((a, d) => (d.spend > a.spend ? d : a), days[0]);
    return { first, last, map, weeks, mx, top };
  }, [days]);
  if (!geo) return null;
  const c = geo.weeks > 14 ? 14 : cell;
  const g = geo.weeks > 14 ? 3 : gap;
  const W = geo.weeks * (c + g) + 24;
  const H = 7 * (c + g) + 6;
  const cells = [];
  for (let k = 0; k < geo.weeks * 7; k++) {
    const iso = addDays(geo.first, k);
    if (iso > geo.last) break;
    const x = Math.floor(k / 7) * (c + g) + 22;
    const y = (k % 7) * (c + g) + 4;
    const d = geo.map.get(iso);
    if (!d) {
      cells.push(<rect key={iso} x={x} y={y} width={c} height={c} rx={c > 20 ? 7 : 3} fill="none" stroke="var(--hair2)" strokeDasharray="2 3" />);
      continue;
    }
    const a = d.spend === 0 ? 0 : 0.16 + 0.78 * (d.spend / geo.mx);
    const onInk = a > 0.55;
    cells.push(
      <g key={iso} onClick={() => onSelect?.(iso)} style={{ cursor: onSelect ? "pointer" : "default" }}>
        <title>{`${longDate(iso)} · ${d.count} event${d.count === 1 ? "" : "s"} · spent ${inrCompact(d.spend)}`}</title>
        <rect x={x} y={y} width={c} height={c} rx={c > 20 ? 7 : 3} fill="var(--out)" fillOpacity={a} stroke="var(--hair)" />
        {c > 20 && <text x={x + 6} y={y + 14} fontFamily="var(--mono)" fontSize="10.5" fill={onInk ? "var(--onink)" : "var(--ink)"}>{parseISO(iso).getUTCDate()}</text>}
        {c > 20 && Array.from({ length: Math.min(d.count, 6) }).map((_, q) => <circle key={q} cx={x + 8 + q * 6} cy={y + c - 8} r={2.1} fill={onInk ? "var(--onink)" : "var(--ink)"} />)}
        {iso === geo.top.date && geo.top.spend > 0 && <rect x={x - 2} y={y - 2} width={c + 4} height={c + 4} rx={c > 20 ? 9 : 4} fill="none" stroke="var(--ink)" strokeWidth="2" />}
      </g>,
    );
  }
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: W }} role="img" aria-label="Calendar of daily spending: shade is money spent, dots are events">
      {"MTWTFSS".split("").map((l, r) => <text key={r} x={0} y={r * (c + g) + 4 + c * 0.62} fontFamily="var(--mono)" fontSize="10.5" fill="var(--ink3)">{l}</text>)}
      {cells}
    </svg>
  );
}
