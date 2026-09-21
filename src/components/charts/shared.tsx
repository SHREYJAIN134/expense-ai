"use client";
import type { ReactNode } from "react";
import { inr, inrCompact } from "@/lib/client/format";

/** Chart palette: Ledger Line tokens: green in, red out, blue = estimate, ink = actual balance. */
export const C = {
  income: "var(--in)",
  spending: "var(--out)",
  net: "var(--est)",
  accent: "var(--ink)",
  violet: "var(--ink3)",
  amber: "var(--est)",
  slate: "var(--hair)",
  grid: "var(--grid-line)",
  tick: "var(--text-faint)",
};

export const axisProps = {
  tick: { fill: "var(--text-faint)", fontSize: 11 },
  axisLine: { stroke: "var(--border)" },
  tickLine: false as const,
};

export const moneyTick = (v: number) => inrCompact(v);

interface TipRow {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string;
  payload?: any;
}

/** Shared tooltip: title + one row per series with a colour key and tabular numbers. */
export function Tip({
  active,
  payload,
  label,
  format = (v: number) => inr(v),
  title,
  extra,
}: {
  active?: boolean;
  payload?: TipRow[];
  label?: string | number;
  format?: (v: number, name?: string) => string;
  title?: (label: string | number | undefined, payload: TipRow[]) => ReactNode;
  extra?: (payload: TipRow[]) => ReactNode;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="tt">
      <div className="th">{title ? title(label, payload) : label}</div>
      {payload
        .filter((p) => p.value !== undefined && p.value !== null)
        .map((p, i) => (
          <div className="tr" key={i}>
            <span className="row" style={{ gap: 6 }}>
              <span className="dot" style={{ background: p.color }} />
              {p.name}
            </span>
            <b>{typeof p.value === "number" ? format(p.value, p.name) : p.value}</b>
          </div>
        ))}
      {extra?.(payload)}
    </div>
  );
}

export function ChartEmpty({ children = "No data in this range" }: { children?: ReactNode }) {
  return (
    <div className="empty" style={{ padding: "48px 12px" }}>
      {children}
    </div>
  );
}

export function LegendRow({ items }: { items: { label: string; color: string; dashed?: boolean }[] }) {
  return (
    <div className="row wrap" style={{ gap: 14, fontSize: 12, color: "var(--text-dim)", marginBottom: 8 }}>
      {items.map((i) => (
        <span key={i.label} className="row" style={{ gap: 6 }}>
          <span style={{ width: 12, height: i.dashed ? 0 : 8, borderRadius: 3, background: i.dashed ? "transparent" : i.color, borderTop: i.dashed ? `2px dashed ${i.color}` : undefined, display: "inline-block" }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}
