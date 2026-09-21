/**
 * Unusual-activity detection. Deterministic statistics only (median / MAD robust z-scores, Poisson counts,
 * rolling windows) - no language model, no randomness. The same transactions always give the same result.
 *
 * "Unusual" means "statistically unlike your own history". It is NOT a claim of fraud or wrongdoing, and the UI
 * words it that way.
 *
 * Every finding carries: type, severity, references (transaction / category / merchant), the observed value, the
 * historical baseline it was compared with, a plain-language reason, a confidence and the date it refers to.
 *
 * Guards against misleading conclusions:
 *  - amounts below `minAmount` are never flagged;
 *  - each detector needs a minimum amount of history and stays silent below it;
 *  - recurring payments and bill-like categories (rent, utilities...) are lumpy by nature and are excluded from the
 *    "everyday spending" detectors, so paying rent on the 1st never looks like a spike;
 *  - refunded purchases are measured net of the refund.
 */
import { categoryLabel, NON_SPENDING_CATEGORIES } from "../domain/categories";
import type { TxnLite } from "../domain/types";
import { addDays, daysBetween, formatDateLong, type ISODate } from "../util/dates";
import { formatINR, median, round2, sum } from "../util/money";
import { isDebit, netDebits, refundOffsets } from "./engine";

export type AnomalyType =
  | "large_transaction"
  | "frequent_transactions"
  | "merchant_spike"
  | "category_spike"
  | "unusual_day"
  | "spending_spike"
  | "possible_duplicate";

export type AnomalySeverity = "low" | "medium" | "high";

export interface UnusualActivity {
  /** Deterministic id: the same finding gets the same id on every run. */
  id: string;
  type: AnomalyType;
  severity: AnomalySeverity;
  /** Main transaction the finding is about (when there is one). */
  txnId: string | null;
  /** Every transaction behind the finding. */
  txnIds: string[];
  category: string | null;
  merchant: string | null;
  /** The day the activity happened (window end for rolling-window findings). */
  date: ISODate;
  /** What was seen (rupees, or a count for frequency findings). */
  observed: number;
  /** What normally happens (median / mean of the comparison history). */
  baseline: number;
  baselineLabel: string;
  unit: "amount" | "count";
  /** observed / baseline, when meaningful. */
  ratio: number | null;
  /** Robust z-score, when the detector uses one. */
  score: number | null;
  reason: string;
  /** 0-1. Grows with the amount of history and how far the value is from normal. Never 1. */
  confidence: number;
  /** Number of historical observations the baseline is built from. */
  sampleSize: number;
  /** The "as of" date the analysis ran on (a reproducible timestamp, not wall-clock time). */
  detectedAt: ISODate;
}

export interface AnomalyOptions {
  asOf: ISODate;
  /** Only report activity from the last N days (history before that is still used as the baseline). */
  lookbackDays?: number;
  /** Transactions below this many rupees are never flagged. */
  minAmount?: number;
  /** Ids of transactions that belong to a detected recurring series; treated as expected. */
  recurringIds?: Set<string>;
}

/** Categories whose payments are naturally large and infrequent: no "large compared with everything else" flag. */
const LUMPY = new Set(["RENT", "BILLS", "UTILITIES", "EDUCATION", "INVESTMENTS", "SUBSCRIPTIONS"]);

const Z_THRESHOLD = 3.5;

/** Modified z-score using a floored spread, so a perfectly regular history does not make tiny moves look huge. */
export function robustZ(x: number, sample: number[], floorFraction = 0.05): { z: number; median: number; spread: number } {
  const med = median(sample);
  const mad = median(sample.map((v) => Math.abs(v - med)));
  const spread = Math.max(mad / 0.6745, floorFraction * med, 1);
  return { z: (x - med) / spread, median: med, spread };
}

function severityFor(z: number | null, ratio: number | null): AnomalySeverity {
  if ((z !== null && z >= 8) || (ratio !== null && ratio >= 6)) return "high";
  if ((z !== null && z >= 5) || (ratio !== null && ratio >= 3.5)) return "medium";
  return "low";
}

function confidenceFor(n: number, z: number | null, cap = 0.95): number {
  const history = Math.min(1, n / 30);
  const strength = z === null ? 0.4 : Math.min(1, Math.max(0, (z - Z_THRESHOLD) / 8));
  return Math.round(Math.min(cap, 0.3 + 0.4 * history + 0.25 * strength) * 100) / 100;
}

const SEVERITY_RANK: Record<AnomalySeverity, number> = { high: 3, medium: 2, low: 1 };

export function detectUnusualActivity(input: TxnLite[], opts: AnomalyOptions): UnusualActivity[] {
  const { asOf } = opts;
  // Canonical order (date, then id): the result never depends on the order the rows arrive in.
  const all = [...input].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const lookback = opts.lookbackDays ?? 90;
  const minAmount = opts.minAmount ?? 1000;
  const since = addDays(asOf, -(lookback - 1));
  const recurring = opts.recurringIds ?? new Set(all.filter((t) => t.isRecurring).map((t) => t.id));
  const offsets = refundOffsets(all);
  // Net debits (purchases minus their refunds), excluding investments: the population every detector learns from.
  const debits = netDebits(all.filter((t) => isDebit(t) && t.category !== "INVESTMENTS"), offsets);
  if (debits.length < 8) return [];
  const spending = debits.filter((t) => !NON_SPENDING_CATEGORIES.has(t.category));
  const everyday = spending.filter((t) => !recurring.has(t.id) && !LUMPY.has(t.category));
  const firstDate = all.reduce((a, t) => (t.date < a ? t.date : a), all[0].date);
  const out: UnusualActivity[] = [];
  type Required_ = Pick<UnusualActivity, "id" | "type" | "severity" | "date" | "observed" | "baseline" | "baselineLabel" | "reason" | "confidence" | "sampleSize">;
  const mk = (a: Required_ & Partial<UnusualActivity>): UnusualActivity => ({
    unit: "amount",
    ratio: null,
    score: null,
    txnId: null,
    txnIds: [],
    category: null,
    merchant: null,
    detectedAt: asOf,
    ...a,
  });

  /* 1. Unusually large transaction ------------------------------------------------- */
  const byCat = new Map<string, typeof debits>();
  for (const t of debits) byCat.set(t.category, [...(byCat.get(t.category) ?? []), t]);
  for (const t of debits) {
    if (t.date < since || t.date > asOf || t.net < minAmount || recurring.has(t.id)) continue;
    const peers = (byCat.get(t.category) ?? []).filter((p) => p.id !== t.id && !recurring.has(p.id)).map((p) => p.net);
    let sample = peers;
    let scope = `your usual ${categoryLabel(t.category).toLowerCase()} transactions`;
    let cap = 0.95;
    if (peers.length < 6) {
      if (LUMPY.has(t.category) || NON_SPENDING_CATEGORIES.has(t.category)) continue; // too little history for this kind of payment
      sample = everyday.filter((p) => p.id !== t.id).map((p) => p.net);
      scope = "your usual everyday transactions";
      cap = 0.7; // borrowed baseline: less certain
      if (sample.length < 10) continue;
    }
    const { z, median: med } = robustZ(t.net, sample);
    if (z < Z_THRESHOLD || med <= 0 || t.net < 2 * med) continue;
    const ratio = round2(t.net / med);
    out.push(
      mk({
        id: `large_transaction:${t.id}`,
        type: "large_transaction",
        severity: severityFor(z, ratio),
        txnId: t.id,
        txnIds: [t.id],
        category: t.category,
        merchant: t.merchant,
        date: t.date,
        observed: t.net,
        baseline: round2(med),
        baselineLabel: `typical: ${formatINR(med)}`,
        ratio,
        score: round2(z),
        sampleSize: sample.length,
        confidence: confidenceFor(sample.length, z, cap),
        reason: `${formatINR(t.net)} at ${t.merchant} is about ${ratio}× ${scope} (typically ${formatINR(med)}).`,
      }),
    );
  }

  /* 2. Unusually frequent transactions (per merchant, 7-day window) -------------------- */
  const byMerchant = new Map<string, typeof debits>();
  for (const t of debits) byMerchant.set(t.merchant, [...(byMerchant.get(t.merchant) ?? []), t]);
  for (const [merchant, rows] of byMerchant) {
    if (merchant.startsWith("Unidentified")) continue; // a gateway lumps many real merchants together
    const dates = rows.map((r) => r.date).sort();
    let best: { end: ISODate; count: number; mean: number; z: number; weeks: number; ids: string[] } | null = null;
    for (const end of new Set(dates.filter((d) => d >= since && d <= asOf))) {
      const start = addDays(end, -6);
      const inWin = rows.filter((r) => r.date >= start && r.date <= end);
      // history = whole weeks before this window, from the first time the merchant was seen
      const histStart = dates[0];
      const histDays = daysBetween(histStart, addDays(start, -1)) + 1;
      const weeks = Math.floor(histDays / 7);
      if (weeks < 3) continue;
      const histCount = rows.filter((r) => r.date < start).length;
      const meanWeekly = histCount / weeks;
      const z = (inWin.length - meanWeekly) / Math.sqrt(Math.max(meanWeekly, 0.5));
      if (inWin.length >= 4 && inWin.length >= 3 * Math.max(meanWeekly, 0.5) && z >= 3) {
        if (!best || inWin.length > best.count) best = { end, count: inWin.length, mean: meanWeekly, z, weeks, ids: inWin.map((r) => r.id) };
      }
    }
    if (best) {
      const ratio = round2(best.count / Math.max(best.mean, 0.5));
      out.push(
        mk({
          id: `frequent_transactions:${merchant.toLowerCase()}:${best.end}`,
          type: "frequent_transactions",
          severity: severityFor(best.z + 2, ratio), // count z-scores run smaller than amount z-scores
          txnId: best.ids[best.ids.length - 1],
          txnIds: best.ids,
          merchant,
          category: rows[0].category,
          date: best.end,
          unit: "count",
          observed: best.count,
          baseline: round2(best.mean),
          baselineLabel: `typical: ${round2(best.mean)} per week`,
          ratio,
          score: round2(best.z),
          sampleSize: best.weeks,
          confidence: confidenceFor(best.weeks * 2, best.z + 1, 0.85),
          reason: `${best.count} payments to ${merchant} in 7 days, versus about ${round2(best.mean)} a week normally.`,
        }),
      );
    }
  }

  /* 3 & 4. Merchant / category spending spike (rolling 30-day windows) ------------------ */
  const winLen = 30;
  const curFrom = addDays(asOf, -(winLen - 1));
  const baseWindows: { from: ISODate; to: ISODate }[] = [];
  for (let k = 1; k <= 6; k++) {
    const to = addDays(curFrom, -(k - 1) * winLen - 1);
    const from = addDays(to, -(winLen - 1));
    if (from < firstDate) break; // only windows fully covered by data
    baseWindows.push({ from, to });
  }
  if (baseWindows.length >= 3) {
    const groupAmount = (rows: typeof spending, w: { from: ISODate; to: ISODate }) => sum(rows.filter((r) => r.date >= w.from && r.date <= w.to).map((r) => r.net));
    const check = (kind: "merchant" | "category", key: string, rows: typeof spending) => {
      const cur = groupAmount(rows, { from: curFrom, to: asOf });
      const base = baseWindows.map((w) => groupAmount(rows, w));
      const { z, median: med } = robustZ(cur, base, 0.25);
      const ratio = med > 0 ? round2(cur / med) : null;
      if (med <= 0 || cur - med < minAmount || z < Z_THRESHOLD || ratio === null || ratio < 1.75) return;
      const inWin = rows.filter((r) => r.date >= curFrom && r.date <= asOf);
      const label = kind === "merchant" ? key : categoryLabel(key);
      out.push(
        mk({
          id: `${kind}_spike:${key.toLowerCase()}:${asOf}`,
          type: kind === "merchant" ? "merchant_spike" : "category_spike",
          severity: severityFor(z, ratio),
          txnId: inWin.sort((a, b) => b.net - a.net)[0]?.id ?? null,
          txnIds: inWin.map((r) => r.id),
          merchant: kind === "merchant" ? key : null,
          category: kind === "category" ? key : rows[0].category,
          date: asOf,
          observed: cur,
          baseline: round2(med),
          baselineLabel: `typical 30 days: ${formatINR(med)}`,
          ratio,
          score: round2(z),
          sampleSize: base.length,
          confidence: confidenceFor(base.length * 5, z, 0.85),
          reason: `${formatINR(cur)} on ${label} in the last 30 days, about ${ratio}× your usual ${formatINR(med)} for 30 days.`,
        }),
      );
    };
    const mGroups = new Map<string, typeof spending>();
    const cGroups = new Map<string, typeof spending>();
    for (const t of spending) {
      if (recurring.has(t.id)) continue;
      mGroups.set(t.merchant, [...(mGroups.get(t.merchant) ?? []), t]);
      cGroups.set(t.category, [...(cGroups.get(t.category) ?? []), t]);
    }
    for (const [k, rows] of mGroups) if (!k.startsWith("Unidentified") && !LUMPY.has(rows[0].category)) check("merchant", k, rows);
    for (const [k, rows] of cGroups) if (!LUMPY.has(k)) check("category", k, rows);
  }

  /* 5. Unusual spending day --------------------------------------------------------- */
  const dayTotals = new Map<ISODate, { total: number; top: (typeof everyday)[number] }>();
  for (const t of everyday) {
    const d = dayTotals.get(t.date);
    if (d) {
      d.total += t.net;
      if (t.net > d.top.net) d.top = t;
    } else dayTotals.set(t.date, { total: t.net, top: t });
  }
  const largeIds = new Set(out.filter((a) => a.type === "large_transaction").map((a) => a.txnId));
  if (dayTotals.size >= 10) {
    for (const [date, d] of dayTotals) {
      if (date < since || date > asOf || d.total < 2 * minAmount) continue;
      const sample = [...dayTotals.entries()].filter(([k]) => k !== date).map(([, v]) => v.total);
      const { z, median: med } = robustZ(d.total, sample, 0.25);
      if (z < Z_THRESHOLD || d.total < 2.5 * med) continue;
      if (largeIds.has(d.top.id) && d.top.net >= 0.7 * d.total) continue; // already reported as one large transaction
      const ratio = round2(d.total / med);
      out.push(
        mk({
          id: `unusual_day:${date}`,
          type: "unusual_day",
          severity: severityFor(z, ratio),
          txnId: d.top.id,
          txnIds: everyday.filter((t) => t.date === date).map((t) => t.id),
          date,
          observed: round2(d.total),
          baseline: round2(med),
          baselineLabel: `typical spending day: ${formatINR(med)}`,
          ratio,
          score: round2(z),
          sampleSize: sample.length,
          confidence: confidenceFor(sample.length, z, 0.9),
          reason: `${formatINR(d.total)} spent on ${formatDateLong(date)}, about ${ratio}× a typical spending day (${formatINR(med)}).`,
        }),
      );
    }
  }

  /* 6. Sudden spike in the last 7 days -------------------------------------------------- */
  const weekFrom = addDays(asOf, -6);
  const weekWindows: { from: ISODate; to: ISODate }[] = [];
  for (let k = 1; k <= 8; k++) {
    const to = addDays(weekFrom, -(k - 1) * 7 - 1);
    const from = addDays(to, -6);
    if (from < firstDate) break;
    weekWindows.push({ from, to });
  }
  if (weekWindows.length >= 4) {
    const wk = (w: { from: ISODate; to: ISODate }) => sum(everyday.filter((r) => r.date >= w.from && r.date <= w.to).map((r) => r.net));
    const cur = wk({ from: weekFrom, to: asOf });
    const base = weekWindows.map(wk);
    const { z, median: med } = robustZ(cur, base, 0.25);
    const ratio = med > 0 ? round2(cur / med) : null;
    if (med > 0 && ratio !== null && ratio >= 1.8 && z >= Z_THRESHOLD && cur - med >= 2 * minAmount) {
      const inWin = everyday.filter((r) => r.date >= weekFrom && r.date <= asOf);
      out.push(
        mk({
          id: `spending_spike:${asOf}`,
          type: "spending_spike",
          severity: severityFor(z, ratio),
          txnId: [...inWin].sort((a, b) => b.net - a.net)[0]?.id ?? null,
          txnIds: inWin.map((r) => r.id),
          date: asOf,
          observed: round2(cur),
          baseline: round2(med),
          baselineLabel: `typical week: ${formatINR(med)}`,
          ratio,
          score: round2(z),
          sampleSize: base.length,
          confidence: confidenceFor(base.length * 4, z, 0.85),
          reason: `${formatINR(cur)} of everyday spending in the last 7 days, about ${ratio}× a typical week (${formatINR(med)}).`,
        }),
      );
    }
  }

  /* 7. Duplicate-looking activity that passed import ------------------------------------ */
  const dupGroups = new Map<string, typeof debits>();
  for (const t of debits) {
    if (t.date < since || t.date > asOf || t.net < 100 || t.merchant.startsWith("Unidentified")) continue;
    const k = `${t.date}|${t.merchant.toLowerCase()}|${t.debit}`;
    dupGroups.set(k, [...(dupGroups.get(k) ?? []), t]);
  }
  for (const [k, rows] of dupGroups) {
    if (rows.length < 2) continue;
    const amount = rows[0].debit;
    out.push(
      mk({
        id: `possible_duplicate:${k}`,
        type: "possible_duplicate",
        severity: amount >= 5000 ? "medium" : "low",
        txnId: rows[0].id,
        txnIds: rows.map((r) => r.id),
        merchant: rows[0].merchant,
        category: rows[0].category,
        date: rows[0].date,
        unit: "count",
        observed: rows.length,
        baseline: 1,
        baselineLabel: "normally 1 payment of this amount per day",
        ratio: rows.length,
        sampleSize: debits.length,
        confidence: amount >= 1000 ? 0.6 : 0.45,
        reason: `${rows.length} payments of ${formatINR(amount)} to ${rows[0].merchant} on ${formatDateLong(rows[0].date)}. They may be separate purchases, or the same one entered twice.`,
      }),
    );
  }

  return out.sort(
    (a, b) =>
      SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
      (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
      b.observed - a.observed ||
      (a.id < b.id ? -1 : 1),
  );
}
