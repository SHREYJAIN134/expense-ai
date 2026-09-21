"use client";
/**
 * The Strip — the one picture Expense AI hangs on.
 * Top lane: balance (solid line = read from statements, dashed + hatched band = estimate).
 * Bottom lane: money in (above the baseline) and money out (below): solid red = spent, hollow = moved, not spent;
 * hatched columns = estimated everyday spending and named upcoming payments.
 */
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { StripData } from "@/lib/services/strip";
import { inr, inrCompact, longDate, shortDate } from "@/lib/client/format";

type EstItem = NonNullable<StripData["estimate"]>["items"][number];
const sq = (v: number, max: number) => (max <= 0 ? 0 : Math.sqrt(Math.max(0, v) / max));

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((e) => setW(Math.round(e[0].contentRect.width)));
    ro.observe(el);
    setW(Math.round(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

export function StripLegend({ estimate = true }: { estimate?: boolean }) {
  return (
    <div className="legend-line">
      <span className="k"><i className="solid" /> Solid — read from your statements</span>
      {estimate && <span className="k"><i className="est" style={{ backgroundImage: "repeating-linear-gradient(135deg, var(--est) 0 1.4px, transparent 1.4px 6px)" }} /> Hatched — an estimate</span>}
      <span className="k"><i className="hollowk" /> Hollow — moved, not spent</span>
    </div>
  );
}

export interface StripProps {
  data: StripData;
  height?: number;
  /** Override: hide the estimate even if the data has one. */
  showEstimate?: boolean;
  onSelectDay?: (date: string) => void;
  /** Maximum number of estimated days to draw beyond the last statement day. */
  estimateDays?: number;
}

export default function Strip({ data, height, showEstimate = true, onSelectDay, estimateDays }: StripProps) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const uid = useId().replace(/[^A-Za-z0-9]/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const compact = width > 0 && width < 560;
  const labels = !compact;
  const h = height ?? (compact ? 200 : 300);

  const est = useMemo(() => {
    if (!showEstimate || !data.estimate) return [];
    const cap = estimateDays ?? data.staleDays + (data.view === "week" ? 14 : 30);
    return data.estimate.days.slice(0, Math.max(0, cap));
  }, [data, showEstimate, estimateDays]);

  const geo = useMemo(() => {
    const days = data.days;
    const n = days.length + est.length;
    const padl = compact ? 6 : 56;
    const padr = compact ? 6 : 12;
    const w = Math.max(width, 200);
    const cw = (w - padl - padr) / Math.max(1, n);
    const balTop = 26;
    const balBot = Math.round(h * 0.36);
    const base = Math.round(h * 0.62);
    const upMax = base - Math.round(h * 0.42) - 6;
    const dnMax = h - base - (labels ? 34 : 10);
    const bals = [...days.map((d) => d.balance).filter((b): b is number => b !== null), ...est.flatMap((e) => [e.likely, e.low, e.high])];
    const lo = bals.length ? Math.min(...bals) : 0;
    const hi = bals.length ? Math.max(...bals) : 1;
    const span = Math.max(1, hi - lo);
    const yb = (v: number) => balBot - ((v - lo) / (span * 1.04)) * (balBot - balTop);
    const mxIn = Math.max(1, ...days.map((d) => d.in));
    const mxOut = Math.max(1, ...days.map((d) => Math.max(d.spend + d.moved, 1)), ...est.map((e) => e.everyday));
    const x = (i: number) => padl + i * cw;
    return { n, padl, padr, w, cw, balTop, balBot, base, upMax, dnMax, yb, mxIn, mxOut, x };
  }, [data, est, width, h, compact, labels]);

  if (!width) return <div ref={ref} style={{ height: h }} aria-hidden />;

  const { cw, padl, padr, w, balTop, base, upMax, dnMax, yb, mxIn, mxOut, x } = geo;
  const days = data.days;
  const nA = days.length;
  const bw = Math.max(cw * 0.64, 2.5);
  const lastActual = nA - 1;
  const tx = x(lastActual) + cw;

  const actualPts = days.map((d, i) => (d.balance === null ? null : `${(x(i) + cw / 2).toFixed(1)},${yb(d.balance).toFixed(1)}`)).filter(Boolean).join(" ");
  const lastBal = [...days].reverse().find((d) => d.balance !== null)?.balance ?? null;
  const anchor = lastBal !== null ? [x(lastActual) + cw / 2, yb(lastBal)] : null;
  const estPts = anchor ? [anchor, ...est.map((e, j) => [x(nA + j) + cw / 2, yb(e.likely)])] : [];
  const bandUp = anchor ? [anchor, ...est.map((e, j) => [x(nA + j) + cw / 2, yb(e.high)])] : [];
  const bandLo = anchor ? [anchor, ...est.map((e, j) => [x(nA + j) + cw / 2, yb(e.low)])] : [];
  const bandPts = [...bandUp, ...[...bandLo].reverse()].map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");

  const itemsByDate = new Map<string, EstItem[]>();
  for (const it of data.estimate?.items ?? []) itemsByDate.set(it.date, [...(itemsByDate.get(it.date) ?? []), it]);

  // week-boundary lines and labels
  const ticks: { i: number; text: string; est: boolean }[] = [];
  const all = [...days.map((d) => d.date), ...est.map((e) => e.date)];
  let lastTick = -99;
  all.forEach((iso, i) => {
    const d = new Date(iso + "T00:00:00Z");
    const dow = d.getUTCDay();
    const dom = d.getUTCDate();
    if (data.view === "quarter" || data.view === "year") {
      if (dom === 1) ticks.push({ i, text: d.toLocaleString("en-IN", { month: "short", timeZone: "UTC" }), est: i >= nA });
    } else if ((dow === 1 || dom === 1) && (dom === 1 || (i - lastTick) * cw > 34)) {
      lastTick = i;
      ticks.push({ i, text: dom === 1 ? `${dom} ${d.toLocaleString("en-IN", { month: "short", timeZone: "UTC" })}` : String(dom), est: i >= nA });
    }
  });

  const hoverDay = hover !== null ? (hover < nA ? days[hover] : null) : null;
  const hoverEst = hover !== null && hover >= nA ? est[hover - nA] : null;
  const hoverIso = hover !== null ? all[hover] : null;
  const lastLabel = data.staleDays <= 1 ? `Today · ${shortDate(data.dataThrough ?? data.to)}` : `Last statement · ${shortDate(data.dataThrough ?? data.to)}`;

  return (
    <div className="strip-wrap" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} role="img" aria-label={`Money strip for ${longDate(data.from)} to ${longDate(data.to)}: daily money in, spending and balance${est.length ? ", followed by an estimated path" : ""}.`}>
        <defs>
          <pattern id={`hl${uid}`} width="5" height="5" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="1.2" height="5" fill="var(--est)" opacity=".6" /></pattern>
        </defs>
        {ticks.map((t) => (
          <g key={t.i}>
            <line x1={x(t.i)} y1={balTop - 8} x2={x(t.i)} y2={h - (labels ? 22 : 4)} stroke="var(--hair2)" />
            {labels && <text x={x(t.i) + 3} y={h - 6} fontFamily="var(--mono)" fontSize="10.5" fill={t.est ? "var(--est)" : "var(--ink3)"}>{t.text}</text>}
          </g>
        ))}
        <line x1={padl} y1={base} x2={w - padr} y2={base} stroke="var(--ink)" strokeWidth="1.2" />
        {labels && (
          <g fontFamily="var(--mono)" fontSize="10.5">
            <text x="0" y={balTop + 4} fill="var(--ink3)">BAL</text>
            <text x="0" y={base - 4} fill="var(--in)">IN</text>
            <text x="0" y={base + 14} fill="var(--out)">OUT</text>
          </g>
        )}
        {/* actual flow */}
        {days.map((d, i) => {
          const bx = x(i) + (cw - bw) / 2;
          const els = [];
          if (d.in > 0) {
            const hh = Math.max(3, sq(d.in, mxIn) * upMax);
            els.push(<rect key="in" x={bx} y={base - hh} width={bw} height={hh} fill="var(--in)" rx="1.5" />);
          }
          let y0 = base + 1;
          if (d.spend > 0) {
            const hh = Math.max(3, sq(d.spend, mxOut) * dnMax * 0.85);
            els.push(<rect key="sp" x={bx} y={y0} width={bw} height={hh} fill="var(--out)" rx="1.5" />);
            y0 += hh + 1.5;
          }
          if (d.moved > 0) {
            const hh = Math.max(3, sq(d.moved, mxOut) * dnMax * 0.85);
            els.push(<rect key="mv" x={bx + 0.8} y={y0} width={Math.max(1, bw - 1.6)} height={hh} fill="none" stroke="var(--out)" strokeWidth="1.3" rx="1.5" />);
          }
          return <g key={d.date}>{els}</g>;
        })}
        {/* estimated flow */}
        {est.map((e, j) => {
          const i = nA + j;
          const bx = x(i) + (cw - bw) / 2;
          const named = itemsByDate.get(e.date);
          const ex = named?.filter((n) => n.kind === "expense") ?? [];
          const inc = named?.filter((n) => n.kind === "income") ?? [];
          const everyH = sq(e.everyday, mxOut) * dnMax * 0.85;
          const exAmt = ex.reduce((a, n) => a + n.amount, 0);
          const hh = everyH + (exAmt ? sq(exAmt, mxOut) * dnMax * 0.6 : 0);
          const incAmt = inc.reduce((a, n) => a + n.amount, 0);
          return (
            <g key={e.date}>
              <rect x={bx} y={base + 1} width={bw} height={Math.max(2, hh)} fill={`url(#hl${uid})`} stroke="var(--est)" strokeWidth="1" strokeDasharray="2 2" rx="1.5" />
              {incAmt > 0 && <rect x={bx} y={base - Math.max(3, sq(incAmt, mxIn) * upMax)} width={bw} height={Math.max(3, sq(incAmt, mxIn) * upMax)} fill={`url(#hl${uid})`} stroke="var(--est)" strokeWidth="1" strokeDasharray="2 2" rx="1.5" />}
              {labels && ex.length > 0 && cw > 4 && (
                <text x={bx + bw / 2} y={base + Math.max(2, hh) + 14} textAnchor="middle" fontFamily="var(--font)" fontWeight="600" fontSize="11" fill="var(--est)">
                  {ex[0].name.length > 14 ? ex[0].name.slice(0, 13) + "…" : ex[0].name}
                </text>
              )}
            </g>
          );
        })}
        {/* balance */}
        {actualPts && <polyline points={actualPts} fill="none" stroke="var(--ink)" strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />}
        {est.length > 0 && anchor && (
          <>
            <polygon points={bandPts} fill={`url(#hl${uid})`} opacity=".8" />
            <polyline points={estPts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ")} fill="none" stroke="var(--est)" strokeWidth="2" strokeDasharray="5 4" strokeLinecap="round" />
          </>
        )}
        {/* boundary between what is known and what is estimated */}
        <line x1={tx} y1={balTop - 14} x2={tx} y2={h - (labels ? 24 : 4)} stroke="var(--ink)" strokeWidth="1.4" />
        {anchor && <circle cx={anchor[0]} cy={anchor[1]} r="4.6" fill="var(--ink)" />}
        {labels && (
          <>
            <text x={tx - 8} y={balTop - 18} textAnchor="end" fontFamily="var(--mono)" fontSize="11" fontWeight="500" fill="var(--ink)">{lastLabel}</text>
            {est.length > 0 && <text x={tx + 8} y={balTop - 18} fontFamily="var(--mono)" fontSize="11" fill="var(--est)">ESTIMATE →</text>}
          </>
        )}
        {/* hover columns */}
        {all.map((iso, i) => (
          <rect
            key={iso}
            x={x(i)}
            y={0}
            width={cw}
            height={h}
            fill={hover === i ? "var(--ink)" : "transparent"}
            fillOpacity={hover === i ? 0.06 : 0}
            style={{ cursor: onSelectDay && i < nA ? "pointer" : "default" }}
            onMouseEnter={() => setHover(i)}
            onClick={() => i < nA && onSelectDay?.(iso)}
          />
        ))}
      </svg>
      {hover !== null && hoverIso && (
        <div className="strip-tip" style={{ left: Math.min(w - 90, Math.max(90, x(hover) + cw / 2)), top: balTop + 6 }} role="status">
          <div>{longDate(hoverIso)}{hoverEst ? " · estimate" : ""}</div>
          {hoverDay && (
            <div style={{ opacity: 0.85 }}>
              {hoverDay.count ? `${hoverDay.count} event${hoverDay.count > 1 ? "s" : ""}` : "no activity"}
              {hoverDay.in > 0 && ` · in ${inrCompact(hoverDay.in)}`}
              {hoverDay.spend > 0 && ` · spent ${inrCompact(hoverDay.spend)}`}
              {hoverDay.moved > 0 && ` · moved ${inrCompact(hoverDay.moved)}`}
              {hoverDay.balance !== null && ` · bal ${inr(hoverDay.balance)}`}
            </div>
          )}
          {hoverEst && <div style={{ opacity: 0.85 }}>likely balance ≈ {inrCompact(hoverEst.likely)} ({inrCompact(hoverEst.low)}–{inrCompact(hoverEst.high)})</div>}
        </div>
      )}
    </div>
  );
}
