"use client";
import { useMemo, useState } from "react";
import { categoryLabel } from "@/lib/client/format";
import { CATEGORY_NAMES } from "@/lib/domain/categories";
import { addDays, addMonths, todayISO, type ISODate } from "@/lib/util/dates";
import { Seg } from "./ui";

export type RangeKey = "1m" | "3m" | "6m" | "12m" | "ytd" | "all" | "custom";

export interface RangeState {
  key: RangeKey;
  from: ISODate | null;
  to: ISODate | null;
  category: string | null;
}

export function rangeFor(key: RangeKey, custom?: { from: string; to: string }): { from: ISODate | null; to: ISODate | null } {
  const today = todayISO();
  switch (key) {
    case "1m": return { from: addDays(addMonths(today, -1), 1), to: today };
    case "3m": return { from: addDays(addMonths(today, -3), 1), to: today };
    case "6m": return { from: addDays(addMonths(today, -6), 1), to: today };
    case "12m": return { from: addDays(addMonths(today, -12), 1), to: today };
    case "ytd": return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case "custom": return { from: custom?.from || null, to: custom?.to || null };
    default: return { from: null, to: null };
  }
}

export const DEFAULT_RANGE: RangeState = { key: "all", from: null, to: null, category: null };

/** Time-range + category filter shared by the dashboard and analytics pages. */
export default function RangeFilter({ value, onChange, categories = true }: { value: RangeState; onChange: (v: RangeState) => void; categories?: boolean }) {
  const [custom, setCustom] = useState({ from: value.from ?? "", to: value.to ?? "" });
  const options = useMemo(
    () => [
      { value: "1m" as RangeKey, label: "1M" },
      { value: "3m" as RangeKey, label: "3M" },
      { value: "6m" as RangeKey, label: "6M" },
      { value: "12m" as RangeKey, label: "1Y" },
      { value: "ytd" as RangeKey, label: "YTD" },
      { value: "all" as RangeKey, label: "All" },
      { value: "custom" as RangeKey, label: "Custom" },
    ],
    [],
  );
  return (
    <div className="toolbar">
      <Seg label="Time range" value={value.key} options={options} onChange={(k) => onChange({ ...value, key: k, ...rangeFor(k, custom) })} />
      {value.key === "custom" && (
        <div className="row" style={{ gap: 6 }}>
          <input className="input" type="date" style={{ width: 150 }} value={custom.from} aria-label="From date" onChange={(e) => { const c = { ...custom, from: e.target.value }; setCustom(c); onChange({ ...value, from: c.from || null, to: c.to || null }); }} />
          <span className="faint">→</span>
          <input className="input" type="date" style={{ width: 150 }} value={custom.to} aria-label="To date" onChange={(e) => { const c = { ...custom, to: e.target.value }; setCustom(c); onChange({ ...value, from: c.from || null, to: c.to || null }); }} />
        </div>
      )}
      {categories && (
        <select className="select" style={{ width: 190 }} aria-label="Category filter" value={value.category ?? ""} onChange={(e) => onChange({ ...value, category: e.target.value || null })}>
          <option value="">All categories</option>
          {CATEGORY_NAMES.map((c) => (
            <option key={c} value={c}>{categoryLabel(c)}</option>
          ))}
        </select>
      )}
    </div>
  );
}
