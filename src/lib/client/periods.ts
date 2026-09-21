/** Period navigation for the Time lens (pure, client-safe). Periods are clipped to the last day that has data. */
import { addDays, addMonths, financialMonthRange, startOfMonth, weekStart, type ISODate } from "../util/dates";
import { MONTH_SHORT, parseISO } from "../util/dates";

export type PeriodUnit = "day" | "week" | "month" | "quarter" | "year" | "all" | "custom";

export interface PeriodWindow {
  from: ISODate;
  to: ISODate;
  label: string;
  /** True when the window runs past the last day with data. */
  partial: boolean;
}

const lastOfMonth = (iso: ISODate) => addDays(addMonths(startOfMonth(iso), 1), -1);
const d = (iso: ISODate) => parseISO(iso).getUTCDate();
const mon = (iso: ISODate) => MONTH_SHORT[parseISO(iso).getUTCMonth()];
const yr = (iso: ISODate) => parseISO(iso).getUTCFullYear();

export function periodWindow(unit: PeriodUnit, offset: number, anchor: ISODate, first: ISODate, msd: number, custom?: { from: ISODate; to: ISODate }): PeriodWindow {
  let from: ISODate;
  let to: ISODate;
  let label: string;
  switch (unit) {
    case "day":
      from = to = addDays(anchor, -offset);
      label = `${d(from)} ${mon(from)} ${yr(from)}`;
      break;
    case "week":
      from = weekStart(addDays(anchor, -7 * offset));
      to = addDays(from, 6);
      label = mon(from) === mon(to) ? `${d(from)}–${d(to)} ${mon(to)} ${yr(to)}` : `${d(from)} ${mon(from)} – ${d(to)} ${mon(to)}`;
      break;
    case "month": {
      const base = addMonths(startOfMonth(anchor), -offset);
      const r = financialMonthRange(base, msd);
      from = r.from;
      to = r.to;
      label = msd <= 1 ? `${mon(from)} ${yr(from)}` : `${d(from)} ${mon(from)} – ${d(to)} ${mon(to)}`;
      break;
    }
    case "quarter": {
      const m0 = Math.floor(parseISO(anchor).getUTCMonth() / 3) * 3;
      const qStart = addMonths(`${yr(anchor)}-${String(m0 + 1).padStart(2, "0")}-01`, -3 * offset);
      from = qStart;
      to = lastOfMonth(addMonths(qStart, 2));
      label = `Q${Math.floor(parseISO(from).getUTCMonth() / 3) + 1} ${yr(from)}`;
      break;
    }
    case "year": {
      const y = yr(anchor) - offset;
      from = `${y}-01-01`;
      to = `${y}-12-31`;
      label = String(y);
      break;
    }
    case "custom":
      from = custom?.from ?? first;
      to = custom?.to ?? anchor;
      label = `${d(from)} ${mon(from)} – ${d(to)} ${mon(to)} ${yr(to)}`;
      break;
    default:
      from = first;
      to = anchor;
      label = "All time";
  }
  return { from, to: to > anchor ? anchor : to, label, partial: to > anchor };
}

/** True when there is nothing earlier to go back to. */
export function atStart(w: PeriodWindow, first: ISODate): boolean {
  return w.from <= first;
}
