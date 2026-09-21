/**
 * Turns a ParsedQuery into a grounded answer: structured `facts` computed from the
 * database via the analytics layer, plus a deterministic `text` rendering.
 * The optional LLM step (llm.ts) only rephrases this - it cannot add numbers.
 */
import { categoryLabel } from "../domain/categories";
import {
  calculateCategorySpend,
  calculateMerchantSpend,
  calculatePeriods,
  calculateSummary,
  filterRange,
  isSpending,
  refundOffsets,
} from "../analytics/engine";
import { analyzeRanges, periodsFromRange, spendTotals, type ChangeThresholds } from "../analytics/compare";
import { monthlyEquivalent } from "../analytics/recurring";
import { merchantKeyOf } from "../classification/merchants";
import type { TxnLite } from "../domain/types";
import { addDays, addMonths, daysBetween, financialMonthRange, formatDateLong, weekStart, type ISODate } from "../util/dates";
import { formatINR, pct, round2, sum } from "../util/money";
import { currentBalance, dataRange, loadAllTxns } from "../services/data";
import { detectSeries, getForecast, getManualObligations, getUpcoming, getDismissedKeys } from "../services/planning";
import { getAnomalies, getSafeToSpend, thresholdsFor } from "../services/intelligence";
import { exportTransactions, getTransaction } from "../services/transactions";
import { dayStats, largestTransactions, rankBy, rankDays, spendingByPeriod, topMerchantsBySpend, type DayMetric, type DayStat } from "../analytics/rankings";
import { getDb } from "../db/client";
import { getSettings } from "../services/users";
import type { Intent, ParsedQuery } from "./intent";
import { describeRange, type ResolvedPeriod } from "./period";
import { buildUpcoming } from "../analytics/planning";

export interface Answer {
  intent: Intent;
  /** Deterministic, self-contained answer text (markdown-lite). */
  text: string;
  /** Structured data the text was computed from. The LLM may only use numbers found here. */
  facts: Record<string, unknown>;
  /** Optional small table for the UI. */
  table?: { columns: string[]; rows: (string | number)[][] };
  /**
   * How the numbers were calculated (period, inclusions, exclusions). Part of `facts`, so a phrasing model sees the
   * exact method and the UI can show "How was this calculated?".
   */
  calculation?: string[];
  /** The day(s) this answer was about, so a follow-up such as "show all transactions for that day" knows which day. */
  focusDates?: string[];
  /** True when the data needed to answer was not available. */
  noData?: boolean;
  suggestions?: string[];
}

const TYPE_LABEL = { FIXED: "Fixed amount", VARIABLE: "Variable amount", AUTOPAY: "AutoPay (stated in the bank narration)" } as const;
const RECURRING_CALC = [
  "A payment counts as recurring only when the same merchant was paid at least 3 times (or a clean fixed pair) at a regular interval; one payment is never called recurring.",
  "AutoPay is shown only when the bank narration says so. Otherwise the amount is Fixed (nearly identical each time) or Variable.",
  "Monthly total = each payment converted to a monthly equivalent and summed; the next date and amount are estimates from the pattern.",
];

const HELP_SUGGESTIONS = [
  "How much did I spend on food last month?",
  "What was my biggest expense this month?",
  "What are my recurring expenses?",
  "What payments are coming up in the next 30 days?",
  "Compare my spending this month with last month",
  "How much can I safely spend this month?",
  "Why did my spending increase this month?",
  "Which categories increased the most?",
  "Show me unusual spending recently",
];

function noDataAnswer(intent: Intent, text: string): Answer {
  return { intent, text, facts: { dataAvailable: false }, noData: true, suggestions: HELP_SUGGESTIONS.slice(0, 3) };
}

/** Ranking questions default to ALL imported data when no period is named. */
function rankingPeriod(q: ParsedQuery, today: ISODate, userId: string): ResolvedPeriod {
  return q.period && q.period.kind !== "all" ? q.period : allDataPeriod(today, userId);
}

const SOURCE_NAMES: Record<string, string> = { HDFC: "HDFC", GOOGLE_PAY: "Google Pay" };
/** "HDFC + Google Pay": one canonical event, every source that reported it (bank first). */
function sourceOf(eventSources: string[]): string {
  return [...eventSources].sort((a, b) => (a === "HDFC" ? -1 : b === "HDFC" ? 1 : 0)).map((x) => SOURCE_NAMES[x] ?? x).join(" + ");
}

function periodOrDefault(p: ResolvedPeriod | null, def: () => ResolvedPeriod): ResolvedPeriod {
  return p ?? def();
}

function allDataPeriod(today: ISODate, userId: string): ResolvedPeriod {
  const r = dataRange(userId);
  return { from: r?.from ?? today, to: r?.to ?? today, label: r ? `across all your data (${describeRange(r.from, r.to)})` : "across all your data", kind: "all" };
}

function coverageNote(userId: string, p: ResolvedPeriod): string {
  const r = dataRange(userId);
  if (!r) return "";
  if (p.to < r.from || p.from > r.to) return ` Your imported data covers ${describeRange(r.from, r.to)}, which doesn't include that period.`;
  if (p.from < r.from && p.kind !== "all") return ` Note: your data only starts on ${formatDateLong(r.from)}, so earlier days are not included.`;
  return "";
}

function inPeriod(txns: TxnLite[], p: ResolvedPeriod): TxnLite[] {
  return filterRange(txns, p.from === "0000-01-01" ? null : p.from, p.to);
}

export function answerQuery(userId: string, q: ParsedQuery, today: ISODate): Answer {
  // An impossible date or an ambiguous year is reported, never silently reinterpreted or replaced by another answer.
  if (q.dateProblem) {
    const text = q.dateProblem.kind === "error" ? `I couldn't read that date: ${q.dateProblem.message} Please check it and ask again.` : q.dateProblem.message;
    return { intent: q.intent, text, facts: { dateProblem: q.dateProblem }, noData: true };
  }
  const txns = loadAllTxns(userId);
  const settings = getSettings(userId);
  const msd = settings.monthStartDay;
  if (!txns.length) {
    return noDataAnswer(q.intent, "I don't have any transactions yet. Upload an HDFC statement (or load the demo data in Settings) and I'll be able to answer questions about your money.");
  }
  const thisMonth = financialMonthRange(today, msd);
  const lastMonth = financialMonthRange(addDays(thisMonth.from, -1), msd);

  switch (q.intent) {
    case "spend_category": {
      const p = periodOrDefault(q.period, () => allDataPeriod(today, userId));
      let rows = inPeriod(txns, p).filter((t) => t.direction === "debit" && t.category === q.category);
      if (q.subcategory) rows = rows.filter((t) => t.subcategory === q.subcategory);
      const off = refundOffsets(txns);
      const refunded = sum(rows.map((t) => Math.min(t.debit, off.get(t.id) ?? 0)));
      const total = round2(sum(rows.map((t) => t.debit)) - refunded);
      const allSpend = sum(inPeriod(txns, p).filter(isSpending).map((t) => t.debit));
      const label = `${categoryLabel(q.category!)}${q.subcategory ? ` › ${q.subcategory}` : ""}`;
      if (!rows.length) return { intent: q.intent, text: `I found no ${label} spending ${p.label}.${coverageNote(userId, p)}`, facts: { category: q.category, subcategory: q.subcategory, period: p, total: 0, count: 0 }, noData: true };
      const merchants = calculateMerchantSpend(rows, { includeTransfers: true, limit: 3 });
      const subs = calculateCategorySpend(rows, { includeNonSpending: true })[0]?.subcategories.slice(0, 3) ?? [];
      const share = pct(total, allSpend);
      return {
        intent: q.intent,
        text: `You spent **${formatINR(total)}** on ${label} ${p.label} across ${rows.length} transaction${rows.length > 1 ? "s" : ""}${refunded > 0 ? ` (net of ${formatINR(refunded)} refunded)` : ""}${allSpend > 0 && !q.subcategory ? ` (${share}% of your ${formatINR(allSpend)} total spending)` : ""}.${merchants.length ? ` Top merchants: ${merchants.map((m) => `${m.merchant} (${formatINR(m.amount)})`).join(", ")}.` : ""}${coverageNote(userId, p)}`,
        facts: { category: q.category, subcategory: q.subcategory, period: p, total, count: rows.length, share, totalSpending: allSpend, topMerchants: merchants, subcategories: subs },
        table: { columns: ["Merchant", "Amount", "Txns"], rows: merchants.map((m) => [m.merchant, formatINR(m.amount), m.count]) },
      };
    }

    case "spend_merchant": {
      const p = periodOrDefault(q.period, () => allDataPeriod(today, userId));
      const rows = inPeriod(txns, p).filter((t) => t.direction === "debit" && t.merchant.toLowerCase() === q.merchant!.toLowerCase());
      if (!rows.length) return { intent: q.intent, text: `I found no payments to ${q.merchant} ${p.label}.${coverageNote(userId, p)}`, facts: { merchant: q.merchant, period: p, total: 0, count: 0 }, noData: true };
      const offM = refundOffsets(txns);
      const refundedM = sum(rows.map((t) => Math.min(t.debit, offM.get(t.id) ?? 0)));
      const total = round2(sum(rows.map((t) => t.debit)) - refundedM);
      const last = rows.reduce((a, t) => (t.date > a ? t.date : a), rows[0].date);
      return {
        intent: q.intent,
        text: `You spent **${formatINR(total)}** on ${q.merchant} ${p.label} (${rows.length} payment${rows.length > 1 ? "s" : ""}${refundedM > 0 ? `, net of ${formatINR(refundedM)} refunded` : ""}, about ${formatINR(total / rows.length)} each). Most recent: ${formatDateLong(last)}.${coverageNote(userId, p)}`,
        facts: { merchant: q.merchant, period: p, total, count: rows.length, average: round2(total / rows.length), lastDate: last },
      };
    }

    case "spend_total": {
      const p = periodOrDefault(q.period, () => ({ ...thisMonth, label: "this month", kind: "current" as const }));
      const rows = inPeriod(txns, p);
      const s = calculateSummary(rows);
      if (!s.transactionCount) return { intent: q.intent, text: `I have no transactions ${p.label}.${coverageNote(userId, p)}`, facts: { period: p }, noData: true };
      const tot = spendTotals(rows, txns);
      const refunds = round2(tot.refunded + tot.unlinkedRefunds);
      const calculation = [
        `Period: ${describeRange(p.from === "0000-01-01" ? (dataRange(userId)?.from ?? today) : p.from, p.to < today ? p.to : today)}.`,
        "Spending = money paid out (debits) excluding transfers to people and investments; credits are never counted as spending.",
        `Refunds are netted: ${formatINR(tot.gross)} paid out minus ${formatINR(refunds)} refunded = ${formatINR(tot.net)}.`,
      ];
      return {
        intent: q.intent,
        text: `${p.label[0].toUpperCase() + p.label.slice(1)} you spent **${formatINR(tot.net)}** (excluding transfers and investments${refunds > 0 ? `, after ${formatINR(refunds)} of refunds` : ""}) and received income of ${formatINR(s.income)}. Total money out was ${formatINR(s.totalDebits)}, including ${formatINR(s.transfersOut)} in transfers and ${formatINR(s.investmentsOut)} in investments.${s.topCategory ? ` Biggest category: ${categoryLabel(s.topCategory.category)} (${formatINR(s.topCategory.amount)}).` : ""}${coverageNote(userId, p)}`,
        facts: { period: p, spending: tot.net, grossSpending: tot.gross, refundsNetted: refunds, income: s.income, totalDebits: s.totalDebits, transfersOut: s.transfersOut, investmentsOut: s.investmentsOut, topCategory: s.topCategory, calculation },
        calculation,
      };
    }

    case "income_total": {
      const p = periodOrDefault(q.period, () => ({ ...lastMonth, label: "last month", kind: "past" as const }));
      const rows = inPeriod(txns, p);
      const s = calculateSummary(rows);
      if (!s.creditCount) return { intent: q.intent, text: `I found no incoming money ${p.label}.${coverageNote(userId, p)}`, facts: { period: p }, noData: true };
      return {
        intent: q.intent,
        text: `**${formatINR(s.totalCredits)}** came into your account ${p.label} (${s.creditCount} credits). Of that, ${formatINR(s.income)} looks like income (salary, interest etc.), ${formatINR(s.transfersIn)} was transfers from people, ${formatINR(s.refunds)} was refunds/cashback and ${formatINR(s.otherCredits)} was other credits.${s.largestCredit ? ` Largest credit: ${formatINR(s.largestCredit.amount)} from ${s.largestCredit.merchant} on ${formatDateLong(s.largestCredit.date)}.` : ""}${coverageNote(userId, p)}`,
        facts: { period: p, totalCredits: s.totalCredits, income: s.income, transfersIn: s.transfersIn, refunds: s.refunds, otherCredits: s.otherCredits, creditCount: s.creditCount, largestCredit: s.largestCredit },
      };
    }

    case "biggest_expense": {
      let p = periodOrDefault(q.period, () => ({ ...thisMonth, label: "this month", kind: "current" as const }));
      let rows = inPeriod(txns, p).filter(isSpending);
      let fellBack = false;
      if (!rows.length && !q.period) {
        p = { ...lastMonth, label: "last month", kind: "past" };
        rows = inPeriod(txns, p).filter(isSpending);
        fellBack = true;
      }
      if (!rows.length) return { intent: q.intent, text: `I found no expenses ${p.label}.${coverageNote(userId, p)}`, facts: { period: p }, noData: true };
      const top = [...rows].sort((a, b) => b.debit - a.debit).slice(0, 5);
      return {
        intent: q.intent,
        text: `${fellBack ? "There are no expenses this month yet, so here is last month. " : ""}Your biggest expense ${p.label} was **${formatINR(top[0].debit)}** to ${top[0].merchant} on ${formatDateLong(top[0].date)} (${categoryLabel(top[0].category)}).`,
        facts: { period: p, top: top.map((t) => ({ date: t.date, merchant: t.merchant, category: t.category, amount: t.debit })) },
        table: { columns: ["Date", "Merchant", "Category", "Amount"], rows: top.map((t) => [t.date, t.merchant, categoryLabel(t.category), formatINR(t.debit)]) },
      };
    }

    case "top_categories": {
      const p = periodOrDefault(q.period, () => ({ from: addDays(today, -89), to: today, label: "in the last 90 days", kind: "past" as const }));
      const cats = calculateCategorySpend(inPeriod(txns, p));
      if (!cats.length) return { intent: q.intent, text: `I found no spending ${p.label}.${coverageNote(userId, p)}`, facts: { period: p }, noData: true };
      const top = cats.slice(0, 5);
      const total = sum(cats.map((c) => c.amount));
      return {
        intent: q.intent,
        text: `${p.label[0].toUpperCase() + p.label.slice(1)}, most of your spending (${formatINR(total)}) went to ${top.map((c) => `${categoryLabel(c.category)} (${formatINR(c.amount)}, ${c.pct}%)`).join(", ")}.${coverageNote(userId, p)}`,
        facts: { period: p, totalSpending: total, categories: top.map((c) => ({ category: c.category, amount: c.amount, pct: c.pct })) },
        table: { columns: ["Category", "Amount", "Share"], rows: top.map((c) => [categoryLabel(c.category), formatINR(c.amount), `${c.pct}%`]) },
      };
    }

    case "monthly_average": {
      const months = calculatePeriods(txns, "monthly", msd);
      const curKey = financialMonthRange(today, msd).from.slice(0, 7);
      const complete = months.filter((m) => m.key !== curKey);
      const use = complete.length ? complete : months;
      if (!use.length) return noDataAnswer(q.intent, "I don't have enough monthly data to calculate an average yet.");
      const avgSpend = round2(sum(use.map((m) => m.spending)) / use.length);
      const avgIncome = round2(sum(use.map((m) => m.income)) / use.length);
      return {
        intent: q.intent,
        text: `Based on ${use.length} ${complete.length ? "complete " : ""}month${use.length > 1 ? "s" : ""} of data, you normally spend about **${formatINR(avgSpend)}** per month (excluding transfers and investments), against average income of ${formatINR(avgIncome)}.${!complete.length ? " (Only a partial month is available, so this is a rough estimate.)" : ""}`,
        facts: { months: use.length, averageMonthlySpending: avgSpend, averageMonthlyIncome: avgIncome, monthsUsed: use.map((m) => ({ month: m.key, spending: m.spending })) },
        table: { columns: ["Month", "Spending", "Income"], rows: use.slice(-6).map((m) => [m.label, formatINR(m.spending), formatINR(m.income)]) },
      };
    }

    case "recurring_list": {
      const series = detectSeries(userId, today).filter((s) => s.kind === "expense" && !s.possiblyEnded);
      const manual = getManualObligations(userId).filter((m) => m.kind === "expense");
      const dismissed = getDismissedKeys(userId);
      const detected = series.filter((s) => !dismissed.has(merchantKeyOf(s.merchant)));
      if (!detected.length && !manual.length) return noDataAnswer(q.intent, "I haven't detected any recurring payments yet (I need at least 3 similar payments about a month apart), and you haven't entered any manually. You can add recurring bills on the Recurring page.");
      const monthly = round2(sum(detected.map(monthlyEquivalent)) + sum(manual.map((m) => monthlyEquivalent({ frequency: m.frequency, averageAmount: m.amount }))));
      const rows: (string | number)[][] = [
        ...manual.map((m) => [m.name, formatINR(m.amount), m.frequency, "Entered by you"]),
        ...detected.slice(0, 12).map((s) => [s.merchant, formatINR(s.expectedAmount), s.frequency, `${TYPE_LABEL[s.type]} - estimated (${s.confidenceLabel} confidence), last paid ${s.lastDate}, next ~${s.nextExpected}`]),
      ];
      return {
        intent: q.intent,
        text: `You have ${manual.length} recurring obligation${manual.length === 1 ? "" : "s"} you entered and ${detected.length} detected from your history. Together they come to roughly **${formatINR(monthly)} per month** (an estimate based on historical patterns).`,
        facts: { manualCount: manual.length, detectedCount: detected.length, estimatedMonthlyTotal: monthly, items: [...manual.map((m) => ({ name: m.name, amount: m.amount, frequency: m.frequency, source: "manual" })), ...detected.slice(0, 12).map((s) => ({ name: s.merchant, amount: s.expectedAmount, type: s.type, frequency: s.frequency, lastDate: s.lastDate, nextExpected: s.nextExpected, confidence: s.confidenceLabel, source: "detected" }))], calculation: RECURRING_CALC },
        calculation: RECURRING_CALC,
        table: { columns: ["Payment", "Amount", "Frequency", "Basis"], rows },
      };
    }

    case "upcoming_payments": {
      const days = q.days ?? (q.period?.kind === "future" ? Math.max(1, daysBetween(today, q.period.to)) : 30);
      const up = getUpcoming(userId, days, today);
      const exp = up.items.filter((i) => i.kind === "expense");
      if (!exp.length) return noDataAnswer(q.intent, `I don't expect any recurring payments in the next ${days} days based on your history and the obligations you've entered.`);
      const total = round2(sum(exp.map((i) => i.amount)));
      return {
        intent: q.intent,
        text: `Based on historical patterns and obligations you entered, I estimate **${exp.length} payment${exp.length > 1 ? "s" : ""} totalling about ${formatINR(total)}** in the next ${days} days. These are expectations, not guaranteed amounts or dates.`,
        facts: { days, total, count: exp.length, items: exp.map((i) => ({ name: i.name, amount: i.amount, date: i.date, source: i.source, confidence: i.confidence })) },
        table: { columns: ["Expected", "Payment", "Amount (est.)", "Basis"], rows: exp.slice(0, 15).map((i) => [i.date, i.name, formatINR(i.amount), i.source === "manual" ? "You entered" : `Pattern (${i.confidence})`]) },
      };
    }

    case "compare_periods":
    case "spending_trend": {
      const p1 = q.period && q.period.kind !== "all" ? q.period : { ...thisMonth, label: "this month", kind: "current" as const };
      const len = daysBetween(p1.from, p1.to) + 1;
      // Compare like-for-like: previous period of the same length (for a month-to-date: same number of days last month).
      let p2From: ISODate;
      let p2To: ISODate;
      let p2Label: string;
      if (p1.label === "this month") {
        const elapsed = Math.min(daysBetween(thisMonth.from, today), daysBetween(lastMonth.from, lastMonth.to));
        p2From = lastMonth.from;
        p2To = addDays(lastMonth.from, elapsed);
        p2Label = "the same point last month";
        p1.to = today < p1.to ? today : p1.to;
      } else if (p1.label === "last month") {
        const prev = financialMonthRange(addDays(lastMonth.from, -1), msd);
        p2From = prev.from;
        p2To = prev.to;
        p2Label = "the month before";
      } else {
        p2From = addDays(p1.from, -len);
        p2To = addDays(p1.from, -1);
        p2Label = "the previous period";
      }
      const a = calculateSummary(filterRange(txns, p1.from, p1.to));
      const b = calculateSummary(filterRange(txns, p2From, p2To));
      const aNet = spendTotals(filterRange(txns, p1.from, p1.to), txns).net; // refund-netted, transfers/investments excluded
      const bNet = spendTotals(filterRange(txns, p2From, p2To), txns).net;
      if (!a.transactionCount && !b.transactionCount) return noDataAnswer(q.intent, `I have no transactions for ${p1.label} or ${p2Label}.`);
      const diff = round2(aNet - bNet);
      const change = bNet > 0 ? pct(Math.abs(diff), bNet) : null;
      const catA = calculateCategorySpend(filterRange(txns, p1.from, p1.to));
      const catB = new Map(calculateCategorySpend(filterRange(txns, p2From, p2To)).map((c) => [c.category, c.amount]));
      const movers = catA
        .map((c) => ({ category: c.category, now: c.amount, before: catB.get(c.category) ?? 0, delta: round2(c.amount - (catB.get(c.category) ?? 0)) }))
        .sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta))
        .slice(0, 4);
      const direction = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
      return {
        intent: q.intent,
        text: `Spending ${p1.label} is **${formatINR(aNet)}** versus ${formatINR(bNet)} for ${p2Label}: ${direction === "flat" ? "unchanged" : `${direction} ${formatINR(Math.abs(diff))}${change !== null ? ` (${change}%)` : ""}`}.${movers.length ? ` Biggest movers: ${movers.map((m) => `${categoryLabel(m.category)} ${m.delta >= 0 ? "+" : "-"}${formatINR(Math.abs(m.delta))}`).join(", ")}.` : ""}${p1.label === "this month" ? " (The current month is still in progress.)" : ""}`,
        facts: { current: { label: p1.label, from: p1.from, to: p1.to, spending: aNet, income: a.income }, previous: { label: p2Label, from: p2From, to: p2To, spending: bNet, income: b.income }, difference: diff, percentChange: change, direction, movers },
        table: { columns: ["Category", "Now", "Before", "Change"], rows: movers.map((m) => [categoryLabel(m.category), formatINR(m.now), formatINR(m.before), `${m.delta >= 0 ? "+" : "-"}${formatINR(Math.abs(m.delta))}`]) },
      };
    }

    case "anomalies": {
      const from = q.period?.from && q.period.kind !== "all" ? q.period.from : addDays(today, -29);
      const scope = q.period && q.period.kind !== "all" ? q.period.label : "in the last 30 days";
      const list = getAnomalies(userId, today, { lookbackDays: 3650 }).filter((a) => a.date >= from && a.date <= today);
      const calculation = [
        `Window: ${describeRange(from, today)}.`,
        `Unusual activity = statistically different from your own history (robust median/MAD scores over your past transactions, rolling windows for spikes). Amounts under ${formatINR(settings.anomalyMinAmount)} are never flagged, and recurring bills are treated as expected.`,
        "This only shows what differs from your own normal pattern; it says nothing about whether a payment is right or wrong.",
      ];
      if (!list.length) {
        return { intent: q.intent, text: `I didn't find any unusual activity ${scope} compared with your normal spending patterns. (Unusual activity only means different from your own history.)`, facts: { count: 0, period: scope, calculation }, calculation, noData: false };
      }
      const top = list.slice(0, 6);
      const kinds = [...new Set(list.map((a) => a.type.replace(/_/g, " ")))];
      return {
        intent: q.intent,
        text: `I found **${list.length} item${list.length > 1 ? "s" : ""} of unusual activity** ${scope} (${kinds.join(", ")}). The most notable: ${top[0].reason} Unusual doesn't mean wrong - it just stands out from your normal pattern.`,
        facts: {
          count: list.length,
          period: scope,
          items: top.map((a) => ({ type: a.type, severity: a.severity, date: a.date, merchant: a.merchant, category: a.category, observed: a.observed, baseline: a.baseline, confidence: a.confidence, reason: a.reason })),
          calculation,
        },
        calculation,
        table: { columns: ["Date", "What", "Amount / count", "Why it stands out", "Confidence"], rows: top.map((a) => [a.date, a.merchant ?? (a.category ? categoryLabel(a.category) : "Everyday spending"), a.unit === "count" ? `${a.observed} payments` : formatINR(a.observed), a.reason, `${Math.round(a.confidence * 100)}%`]) },
      };
    }

    case "transaction_list": {
      // Filters were extracted from the question BEFORE this query runs; the database - not a language model - decides the rows.
      const dr = dataRange(userId);
      const asAll = !!q.period && q.period.kind === "all";
      const p: ResolvedPeriod = q.period && !asAll ? q.period : asAll ? { from: dr?.from ?? today, to: dr?.to ?? today, label: "across all your data", kind: "all" } : { from: addDays(today, -29), to: today, label: "in the last 30 days", kind: "past" };
      const to = p.to > today ? today : p.to;
      const LIST_CAP = 1000;
      const rows = exportTransactions(userId, { from: p.from, to, direction: q.direction, merchant: q.merchant, category: q.category, subcategory: q.subcategory, sort: "date", dir: "asc" }, LIST_CAP)
        .sort((a, b) => (a.date === b.date ? (a.time ?? "99:99").localeCompare(b.time ?? "99:99") : a.date < b.date ? -1 : 1));
      const single = p.from === to;
      const where = single ? (p.label === "today" || p.label === "yesterday" ? `${p.label} (${formatDateLong(p.from)})` : `on ${formatDateLong(p.from)}`) : `${p.label.startsWith("from ") ? p.label : `between ${formatDateLong(p.from)} and ${formatDateLong(to)}`}`;
      const noneWhere = single ? `for ${formatDateLong(p.from)}` : where;
      const what = [q.direction === "debit" ? "debit" : q.direction === "credit" ? "credit" : "", q.merchant ? `${q.merchant}` : "", q.category ? `${categoryLabel(q.category)}` : ""].filter(Boolean);
      const qualifier = [q.direction ? (q.direction === "debit" ? "debits (money out)" : "credits (money in)") : "", q.merchant ? `merchant ${q.merchant}` : "", q.category ? `category ${categoryLabel(q.category)}${q.subcategory ? ` › ${q.subcategory}` : ""}` : ""].filter(Boolean).join(", ");
      const calculation = [
        `Period: ${describeRange(p.from, to)}${qualifier ? `; filters: ${qualifier}` : ""}.`,
        "Every transaction dated in the period is listed from your transaction records. A payment found in both HDFC and Google Pay is one transaction and is listed once, with both sources shown.",
      ];
      const base = { intent: q.intent, calculation };
      if (!rows.length) {
        return { ...base, text: `No transactions were found ${noneWhere}${qualifier ? ` (${qualifier})` : ""}.${coverageNote(userId, p)}`, facts: { period: { from: p.from, to }, count: 0, transactions: [], calculation }, noData: true };
      }
      const sourceText = (r: (typeof rows)[number]) => [...r.eventSources].sort((a, b) => (a === "HDFC" ? -1 : b === "HDFC" ? 1 : 0)).map((s) => (s === "GOOGLE_PAY" ? "Google Pay" : s === "HDFC" ? "HDFC" : s)).join(" + ");
      const items = rows.map((r) => ({
        date: r.date,
        time: r.time,
        merchant: r.merchant ?? "Unknown",
        amount: r.amount,
        type: r.direction === "debit" ? "Debit" : "Credit",
        category: categoryLabel(r.category),
        source: sourceText(r),
        paymentMethod: r.paymentMethod,
      }));
      const outRows = rows.filter((r) => r.direction === "debit");
      const inRows = rows.filter((r) => r.direction === "credit");
      const outTotal = round2(sum(outRows.map((r) => r.debit)));
      const inTotal = round2(sum(inRows.map((r) => r.credit)));
      const lines = items.map((it, i) => `${i + 1}. ${single ? "" : `${formatDateLong(it.date)} · `}${it.time ? `${it.time} · ` : ""}${it.merchant} — ${formatINR(it.amount)} — ${it.type} — ${it.category}${it.paymentMethod ? ` — ${it.paymentMethod}` : ""} — ${it.source}`);
      const head = `Found **${rows.length} transaction${rows.length === 1 ? "" : "s"}** ${where}${what.length ? ` (${qualifier})` : ""}.`;
      const summary = `Money out: ${formatINR(outTotal)} across ${outRows.length} debit${outRows.length === 1 ? "" : "s"} · Money in: ${formatINR(inTotal)} across ${inRows.length} credit${inRows.length === 1 ? "" : "s"}. (Transfers to people and investments are listed but are not counted as spending.)`;
      const capNote = rows.length >= LIST_CAP ? `\nShowing the first ${LIST_CAP}; narrow the dates to see the rest.` : "";
      return {
        ...base,
        text: [head, summary, "", ...lines].join("\n") + capNote + (p.kind === "future" || (q.period !== null && q.period.to > today) ? "\n(Days that have not happened yet are not included.)" : ""),
        focusDates: single ? [p.from] : undefined,
        facts: { period: { from: p.from, to }, count: rows.length, direction: q.direction ?? "both", merchant: q.merchant, category: q.category, debitCount: outRows.length, debitTotal: outTotal, creditCount: inRows.length, creditTotal: inTotal, transactions: items, calculation },
      };
    }

    case "historical_balance": {
      const p = q.period!;
      const target = p.to > today ? today : p.to;
      const dr = dataRange(userId);
      const row = getDb()
        .prepare("SELECT balance_after AS b, txn_date AS d FROM transactions WHERE user_id = ? AND is_primary = 1 AND balance_after IS NOT NULL AND txn_date <= ? ORDER BY txn_date DESC, seq DESC, id DESC LIMIT 1")
        .get(userId, target) as { b: number; d: string } | undefined;
      const calculation = ["Balance = the running balance printed on the last bank-statement transaction on or before that date (Google Pay statements carry no balance)."];
      if (!row || (dr && target < dr.from)) {
        return { intent: q.intent, text: `I don't have a recorded balance for ${formatDateLong(target)}${dr ? `: your data starts on ${formatDateLong(dr.from)}` : ""}.`, facts: { date: target, balance: null, calculation }, calculation, noData: true };
      }
      if (dr && target > dr.to) {
        return { intent: q.intent, text: `I only have data up to ${formatDateLong(dr.to)}, so I can't tell your balance on ${formatDateLong(target)}. Your latest known balance is ${formatINR(row.b)} as of ${formatDateLong(row.d)}.`, facts: { date: target, balance: null, latestKnownBalance: row.b, latestKnownAsOf: row.d, calculation }, calculation, noData: true };
      }
      const same = row.d === target;
      return {
        intent: q.intent,
        text: same
          ? `Your balance at the end of ${formatDateLong(target)} was **${formatINR(row.b)}** (the running balance after the last transaction that day).`
          : `Your balance at the end of ${formatDateLong(target)} was **${formatINR(row.b)}**. There were no bank transactions after ${formatDateLong(row.d)}, so it had not changed since then.`,
        facts: { date: target, balance: row.b, balanceFromTransactionOn: row.d, calculation },
        calculation,
      };
    }

    case "busiest_day":
    case "top_spending_day":
    case "top_income_day":
    case "top_value_day": {
      // Deterministic aggregation over canonical events (see analytics/rankings.ts). Nothing here involves a language model.
      const p = rankingPeriod(q, today, userId);
      const to = p.to > today ? today : p.to;
      const rows = txns.filter((t) => t.date >= p.from && t.date <= to);
      const scope = p.label;
      if (!rows.length) return { intent: q.intent, text: `I found no transactions ${scope}.${coverageNote(userId, p)}`, facts: { period: { from: p.from, to } }, noData: true };
      const stats = dayStats(rows, txns);
      const metric: DayMetric = q.intent === "busiest_day" ? "count" : q.intent === "top_spending_day" ? "spending" : q.intent === "top_value_day" ? "value" : q.strictIncome ? "income" : "moneyIn";
      const ranked = rankDays(stats, metric);
      const defs: Record<DayMetric, string> = {
        count: "Transactions per day = canonical financial events dated that day (a payment found in both HDFC and Google Pay counts once; refunds, credits and transfers each count as one).",
        spending: "Spending per day = debits that day excluding transfers to people and investments, with refunds netted against the purchase they reverse.",
        moneyIn: "Money received per day = all credits that day (income, transfers from people, refunds), excluding transfers between your own accounts.",
        income: "Income per day = credits categorised as salary/income only. Money from people and refunds is not income.",
        value: "Total transaction value per day = money out + money in for canonical events that day (own-account transfers excluded).",
      };
      const calculation = [`Period: ${describeRange(p.from, to)}.`, defs[metric], "Days with the same top value are all reported as tied."];
      const metricValue = (d: DayStat) => (metric === "count" ? d.count : metric === "spending" ? d.spending : metric === "moneyIn" ? d.moneyIn : metric === "income" ? d.income : d.value);
      const fmtMetric = (d: DayStat) => (metric === "count" ? `${d.count} transaction${d.count === 1 ? "" : "s"}` : formatINR(metricValue(d)));
      const dayRow = (d: DayStat) => [formatDateLong(d.date), d.count, formatINR(d.spending), formatINR(d.moneyIn), formatINR(d.moneyOut)];
      const table = { columns: ["Day", "Transactions", "Total spent", "Total received", "Money out"], rows: ranked.ranked.slice(0, 5).map(dayRow) };
      const brief = (d: DayStat) => ({ date: d.date, transactions: d.count, debits: d.debitCount, credits: d.creditCount, totalSpent: d.spending, totalReceived: d.moneyIn, moneyOut: d.moneyOut, income: d.income, refunds: d.refunds, transfersIn: d.transfersIn, value: d.value, largestPayment: d.largestPayment, largestReceipt: d.largestReceipt });
      const facts = { metric, period: { from: p.from, to }, best: ranked.best, tied: ranked.winners.length > 1, winners: ranked.winners.map(brief), top: ranked.ranked.slice(0, 5).map(brief), calculation };

      if (!ranked.winners.length) {
        const msg = metric === "income"
          ? `No income (salary and similar) was recorded ${scope}. Money from people and refunds isn't counted as income - ask "which day received the most money?" to rank all incoming money.`
          : metric === "moneyIn"
            ? `No money was received ${scope}.`
            : `There was no spending ${scope}.`;
        return { intent: q.intent, text: msg + coverageNote(userId, p), facts: { ...facts, winners: [] }, calculation, noData: true, suggestions: metric === "income" ? ["Which day received the most money?"] : undefined };
      }
      const spent = (d: DayStat) => `Total spent: ${formatINR(d.spending)}${d.moneyOut !== d.spending ? ` (${formatINR(d.moneyOut)} money out including transfers)` : ""}`;
      const headline: Record<DayMetric, (d: DayStat) => string> = {
        count: () => "the highest transaction activity",
        spending: (d) => `the highest spending: **${formatINR(d.spending)}**`,
        moneyIn: (d) => `the most money received: **${formatINR(d.moneyIn)}**`,
        income: (d) => `the highest income: **${formatINR(d.income)}**`,
        value: (d) => `the highest total transaction value: **${formatINR(d.value)}**`,
      };
      const detail = (d: DayStat): string[] => {
        const base = [`- Transactions: ${d.count} (${d.debitCount} debit${d.debitCount === 1 ? "" : "s"}, ${d.creditCount} credit${d.creditCount === 1 ? "" : "s"})`];
        if (metric === "spending") return [base[0], `- Largest payment: ${d.largestPayment ? `${formatINR(d.largestPayment.amount)} at ${d.largestPayment.merchant}` : "—"}`];
        if (metric === "moneyIn" || metric === "income") {
          const other = round2(d.moneyIn - d.income - d.transfersIn - d.refunds);
          const parts = [d.income > 0 ? `income ${formatINR(d.income)}` : "", d.transfersIn > 0 ? `from people / transfers ${formatINR(d.transfersIn)}` : "", d.refunds > 0 ? `refunds ${formatINR(d.refunds)}` : "", other > 0.004 ? `other credits ${formatINR(other)}` : ""].filter(Boolean);
          return [base[0], `- Received: ${parts.join(" · ") || formatINR(d.moneyIn)}`, `- Largest single receipt: ${d.largestReceipt ? `${formatINR(d.largestReceipt.amount)} from ${d.largestReceipt.merchant}` : "—"}`];
        }
        return [...base, `- ${spent(d)}`, `- Total received: ${formatINR(d.moneyIn)}`];
      };
      let text: string;
      if (ranked.winners.length === 1) {
        const d = ranked.winners[0];
        text = [`**${formatDateLong(d.date)}** had ${headline[metric](d)} ${scope}.`, ...detail(d)].join("\n");
      } else {
        const w = ranked.winners;
        text = [`**${w.length} days tied** for ${metric === "count" ? `the highest transaction activity (${fmtMetric(w[0])} each)` : `the top spot (${fmtMetric(w[0])} each)`} ${scope}:`, ...w.flatMap((d) => [`**${formatDateLong(d.date)}**`, ...detail(d)])].join("\n");
      }
      return { intent: q.intent, text, facts, calculation, table, focusDates: ranked.winners.map((d) => d.date) };
    }

    case "largest_transaction": {
      if (q.clarification) return { intent: q.intent, text: q.clarification.message, facts: { clarification: true }, suggestions: q.clarification.suggestions };
      const p = rankingPeriod(q, today, userId);
      const to = p.to > today ? today : p.to;
      const rows = txns.filter((t) => t.date >= p.from && t.date <= to);
      const calculation = [`Period: ${describeRange(p.from, to)}${q.direction ? `; only ${q.direction === "credit" ? "credits (money in)" : "debits (money out)"}` : ""}.`, "Largest SINGLE transaction = the biggest one canonical financial event by amount (not a daily total). Transfers to people are included; transfers between your own accounts are not.", "A payment found in both HDFC and Google Pay is one event."];
      const r = largestTransactions(rows, q.direction);
      if (!r.winners.length) return { intent: q.intent, text: `I found no ${q.direction === "credit" ? "credits" : q.direction === "debit" ? "debits" : "transactions"} ${p.label}.${coverageNote(userId, p)}`, facts: { period: { from: p.from, to } }, calculation, noData: true };
      const detail = r.winners.slice(0, 5).map((w) => {
        const d = getTransaction(userId, w.id);
        return {
          amount: w.amount,
          type: w.direction === "debit" ? "Debit" : "Credit",
          merchant: w.merchant,
          category: categoryLabel(w.category),
          date: w.date,
          time: d?.time ?? null,
          paymentMethod: d?.paymentMethod ?? null,
          source: d ? sourceOf(d.eventSources) : "—",
        };
      });
      const line = (x: (typeof detail)[number]) => `${x.merchant} — ${x.type} — ${x.category} — ${formatDateLong(x.date)}${x.time ? ` ${x.time}` : ""}${x.paymentMethod ? ` — ${x.paymentMethod}` : ""} — ${x.source}`;
      const scoped = q.direction === "credit" ? "credit" : q.direction === "debit" ? "debit" : "transaction";
      const text = r.winners.length === 1
        ? `Your largest ${scoped} ${p.label} was **${formatINR(detail[0].amount)}**:\n${line(detail[0])}`
        : `**${r.winners.length} ${scoped}s tied** for the largest at **${formatINR(detail[0].amount)}** ${p.label}:\n${detail.map((x, i) => `${i + 1}. ${line(x)}`).join("\n")}`;
      return { intent: q.intent, text, facts: { period: { from: p.from, to }, amount: r.best, tied: r.winners.length > 1, transactions: detail, calculation }, calculation, focusDates: [...new Set(r.winners.map((w) => w.date))] };
    }

    case "top_merchants": {
      const p = rankingPeriod(q, today, userId);
      const to = p.to > today ? today : p.to;
      const rows = txns.filter((t) => t.date >= p.from && t.date <= to);
      const byCount = q.rankBy === "count";
      const all = topMerchantsBySpend(rows, txns).sort((a, b) => (byCount ? b.count - a.count || b.amount - a.amount : b.amount - a.amount || b.count - a.count));
      const calculation = [`Period: ${describeRange(p.from, to)}.`, `Merchants ranked by ${byCount ? "number of transactions" : "net spending"} over canonical financial events (refunds netted; a payment in both HDFC and Google Pay counts once).`, "Payments to people are transfers, not merchants, so they are not ranked here."];
      if (!all.length) return { intent: q.intent, text: `I found no merchant spending ${p.label}.${coverageNote(userId, p)}`, facts: { period: { from: p.from, to } }, calculation, noData: true };
      const key = (m: (typeof all)[number]) => (byCount ? m.count : m.amount);
      const tied = all.filter((m) => Math.abs(key(m) - key(all[0])) < 0.005);
      const top = all.slice(0, 5);
      const head = tied.length > 1
        ? `**${tied.length} merchants tied** for the top spot ${p.label} (${byCount ? `${key(all[0])} transactions each` : `${formatINR(all[0].amount)} each`}): ${tied.map((m) => m.merchant).join(", ")}.`
        : byCount
          ? `Your most frequent merchant ${p.label} was **${all[0].merchant}**: ${all[0].count} transactions (${formatINR(all[0].amount)} in total).`
          : `Your top merchant ${p.label} was **${all[0].merchant}**: **${formatINR(all[0].amount)}** across ${all[0].count} transaction${all[0].count === 1 ? "" : "s"} (${all[0].share}% of your spending).`;
      return {
        intent: q.intent,
        text: head,
        facts: { period: { from: p.from, to }, rankedBy: byCount ? "count" : "amount", tied: tied.length > 1, top: top.map((m) => ({ merchant: m.merchant, category: categoryLabel(m.category), amount: m.amount, transactions: m.count, share: m.share })), calculation },
        calculation,
        table: { columns: ["Merchant", "Spent", "Transactions", "Share of spending"], rows: top.map((m) => [m.merchant, formatINR(m.amount), m.count, `${m.share}%`]) },
      };
    }

    case "top_spending_period": {
      const p = rankingPeriod(q, today, userId);
      const to = p.to > today ? today : p.to;
      const grain = q.grain ?? "monthly";
      const buckets = spendingByPeriod(txns, p.from, to, grain, msd);
      const ranked = rankBy(buckets, (b) => b.spending, (b) => b.key);
      const calculation = [`Period: ${describeRange(p.from, to)}.`, `${grain === "weekly" ? "ISO weeks (Mon-Sun)" : "Months"} ranked by net spending (excluding transfers and investments, refunds netted) over canonical financial events.`, "The first and last bucket can be partial if your data does not cover them fully."];
      if (!ranked.winners.length || ranked.best <= 0) return { intent: q.intent, text: `There was no spending ${p.label}.${coverageNote(userId, p)}`, facts: { period: { from: p.from, to } }, calculation, noData: true };
      const unit = grain === "weekly" ? "week" : "month";
      const name = (b: (typeof buckets)[number]) => (grain === "weekly" ? `${b.label} (from ${formatDateLong(weekStart(b.start))})` : b.label);
      const head = ranked.winners.length === 1
        ? `**${name(ranked.winners[0])}** was your highest-spending ${unit} ${p.label}: **${formatINR(ranked.best)}** across ${ranked.winners[0].count} transactions.`
        : `**${ranked.winners.length} ${unit}s tied** as your highest-spending ${unit} (${formatINR(ranked.best)} each): ${ranked.winners.map(name).join("; ")}.`;
      const top = ranked.ranked.slice(0, 5);
      return {
        intent: q.intent,
        text: head,
        facts: { period: { from: p.from, to }, grain, best: ranked.best, tied: ranked.winners.length > 1, top: top.map((b) => ({ label: b.label, start: b.start, spending: b.spending, transactions: b.count })), calculation },
        calculation,
        table: { columns: [grain === "weekly" ? "Week" : "Month", "Spent", "Transactions"], rows: top.map((b) => [name(b), formatINR(b.spending), b.count]) },
      };
    }

    case "balance": {
      const b = currentBalance(userId);
      if (!b) return noDataAnswer(q.intent, "Your imported statements don't include a running balance, so I can't tell your current balance.");
      return { intent: q.intent, text: `Your latest known balance is **${formatINR(b.balance)}**, as of ${formatDateLong(b.asOf)} (the most recent transaction in your imported statements). It may differ from your live balance if you've transacted since.`, facts: { balance: b.balance, asOf: b.asOf } };
    }

    case "safe_to_spend": {
      const s = getSafeToSpend(userId, today);
      if (s.balance === null) return noDataAnswer(q.intent, "Your imported statements don't include a running balance, so I can't calculate a safe-to-spend amount.");
      const calculation = [
        "Safe to spend = current balance - upcoming recurring payments - budget commitments - safety buffer (never below zero).",
        `Window: ${describeRange(s.from, s.to)}. Income that has not arrived yet is not counted.`,
        `Safety buffer: ${s.bufferSource === "user" ? "the amount you set" : "10% of your typical monthly spending"}.`,
      ];
      const lines = [
        s.amount !== null && s.amount > 0
          ? `I estimate you could safely spend about **${formatINR(s.amount)}** until ${formatDateLong(s.to)}, after upcoming bills, budget commitments and a safety buffer.`
          : `I estimate there is **no safe room to spend** until ${formatDateLong(s.to)}: upcoming commitments exceed your balance by about ${formatINR(s.shortfall)}.`,
        `${s.disclaimer} Forecasts are estimates, not guarantees.`,
        "",
        `**Current balance:** ${formatINR(s.balance)} (as of ${s.balanceAsOf ? formatDateLong(s.balanceAsOf) : "the last statement"})`,
        `− **Expected recurring expenses:** ${formatINR(s.upcomingRecurring)}`,
        `− **Budget commitments:** ${formatINR(s.budgetCommitments)}`,
        `− **Safety buffer:** ${formatINR(s.safetyBuffer)}`,
        `= **Safe to spend:** ${formatINR(s.amount ?? 0)}${s.shortfall > 0 ? ` (short by ${formatINR(s.shortfall)} before flooring at zero)` : ""}`,
        "",
        "For context (not part of the calculation):",
        `**Expected income:** ${formatINR(s.expectedIncomeNotCounted)} (estimate, not counted above)`,
        `**Estimated everyday spending:** ${formatINR(s.everydaySpending.expected)} (range ${formatINR(s.everydaySpending.low)}–${formatINR(s.everydaySpending.high)})`,
        `**Estimated remaining cash:** ${s.estimatedRemaining === null ? "n/a" : formatINR(s.estimatedRemaining)} if you spend at your usual pace`,
        ...s.assumptions.slice(0, 2).map((a) => `- ${a}`),
      ];
      return {
        intent: q.intent,
        text: lines.join("\n"),
        facts: {
          currentBalance: s.balance,
          balanceAsOf: s.balanceAsOf,
          upcomingRecurring: s.upcomingRecurring,
          budgetCommitments: s.budgetCommitments,
          safetyBuffer: s.safetyBuffer,
          safeToSpend: s.amount,
          shortfall: s.shortfall,
          through: s.to,
          horizonDays: s.horizonDays,
          expectedIncomeNotCounted: s.expectedIncomeNotCounted,
          estimatedEverydaySpending: s.everydaySpending.expected,
          estimatedRemaining: s.estimatedRemaining,
          confidence: s.confidence,
          calculation,
        },
        calculation,
        table: { columns: ["Expected", "Payment", "Amount (est.)"], rows: s.upcoming.slice(0, 12).map((u) => [u.date, u.name, formatINR(u.amount)]) },
      };
    }

    case "why_spending_changed":
    case "categories_changed": {
      const asked = q.period && q.period.kind !== "all" && q.period.kind !== "future" ? q.period : { ...thisMonth, label: "this month", kind: "current" as const };
      const periods = periodsFromRange({ from: asked.from, to: asked.to, label: asked.label }, today, msd);
      const th: ChangeThresholds = thresholdsFor(settings);
      const sp = analyzeRanges(txns, periods, { monthStartDay: msd, thresholds: th });
      const cur = sp.totals.current;
      const prev = sp.totals.previous;
      const like = periods.partial ? `the same point of ${periods.previous.label.toLowerCase()}` : periods.previous.label.toLowerCase();
      const curName = asked.label;
      const calculation = [
        `Compared ${describeRange(periods.current.from, periods.current.to)} with ${describeRange(periods.previous.from, periods.previous.to)}${periods.partial ? " (same number of elapsed days)" : ""}.`,
        "Spending = debits excluding transfers to people and investments, with refunds netted against the purchase they reverse.",
        `A category or merchant change is only called out when it is at least ${th.minPct}%, ${formatINR(th.minAmount)} and ${th.minTxns} transactions, so small moves and one-offs are ignored.`,
      ];
      if (!cur.transactionCount && !prev.transactionCount) return noDataAnswer(q.intent, `I have no transactions for ${curName} or ${like}.`);
      if (!prev.transactionCount) {
        // Nothing to compare with: never present the whole period as an "increase".
        const from = dataRange(userId)?.from;
        return {
          intent: q.intent,
          text: `I can't tell you why spending changed: I have no transactions for ${like} to compare with${from ? ` (your data starts on ${formatDateLong(from)})` : ""}. ${curName[0].toUpperCase() + curName.slice(1)} you spent ${formatINR(cur.net)}. Upload an earlier statement and I can compare the two periods.`,
          facts: { period: curName, spending: cur.net, comparedWith: like, previousPeriodHasData: false, calculation },
          calculation,
          noData: true,
        };
      }
      const diff = round2(cur.net - prev.net);
      const pctChange = prev.net > 0 ? Math.round((Math.abs(diff) / prev.net) * 1000) / 10 : null;
      const catMovers = sp.categories
        .map((c) => c.change)
        .concat(sp.changes.categories.filter((c) => !sp.categories.some((x) => x.key === c.key)))
        .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

      if (q.intent === "categories_changed") {
        const up = catMovers.filter((c) => c.delta > 0).slice(0, 5);
        const notable = up.filter((c) => c.significant);
        if (!up.length) return { intent: q.intent, text: `No spending category increased ${curName} compared with ${like}.${sp.caveats.length ? ` ${sp.caveats[0]}` : ""}`, facts: { period: curName, calculation }, calculation };
        return {
          intent: q.intent,
          text: `${curName[0].toUpperCase() + curName.slice(1)}, spending rose most in ${up.slice(0, 3).map((c) => `${categoryLabel(c.key)} (+${formatINR(c.delta)}${c.pctChange !== null ? `, +${c.pctChange}%` : ", new"})`).join(", ")} compared with ${like}. ${notable.length ? `${notable.length} of these ${notable.length > 1 ? "are" : "is"} large enough to be worth noticing.` : "None of these changes is large enough to be a real concern under your alert thresholds."}${sp.caveats.length ? ` ${sp.caveats[0]}` : ""}`,
          facts: { period: curName, comparedWith: like, categories: up.map((c) => ({ category: c.key, now: c.current, before: c.previous, change: c.delta, changePct: c.pctChange, notable: c.significant })), calculation },
          calculation,
          table: { columns: ["Category", "Now", "Before", "Change", "Notable?"], rows: up.map((c) => [categoryLabel(c.key), formatINR(c.current), formatINR(c.previous), `+${formatINR(c.delta)}${c.pctChange !== null ? ` (${c.pctChange}%)` : ""}`, c.significant ? "Yes" : "No"]) },
        };
      }

      // why_spending_changed
      const direction = diff > 0 ? "up" : diff < 0 ? "down" : "flat";
      const drivers = catMovers.filter((c) => (diff >= 0 ? c.delta > 0 : c.delta < 0)).slice(0, 4);
      const merchDrivers = sp.changes.merchants.filter((c) => (diff >= 0 ? c.delta > 0 : c.delta < 0)).slice(0, 3);
      const topPayments = sp.categories
        .filter((c) => drivers.some((d) => d.key === c.key) && c.largest)
        .slice(0, 3)
        .map((c) => ({ category: c.key, merchant: c.largest!.merchant, amount: c.largest!.amount, date: c.largest!.date }));
      const negligible = Math.abs(diff) < th.minAmount || (pctChange !== null && pctChange < th.minPct);
      let text: string;
      if (direction === "flat" || negligible) {
        text = `Spending ${curName} is **${formatINR(cur.net)}** versus ${formatINR(prev.net)} for ${like}${direction === "flat" ? ": essentially unchanged" : ` - a difference of ${formatINR(Math.abs(diff))}${pctChange !== null ? ` (${pctChange}%)` : ""}, which is below the level I treat as a real change`}. There is no meaningful increase to explain.`;
      } else {
        const correction = q.asked === "up" && direction === "down" ? "Your spending actually went down, not up. " : q.asked === "down" && direction === "up" ? "Your spending actually went up, not down. " : "";
        text = `${correction}Spending ${curName} is **${formatINR(cur.net)}** versus ${formatINR(prev.net)} for ${like}: ${direction} ${formatINR(Math.abs(diff))}${pctChange !== null ? ` (${pctChange}%)` : ""}.`;
        if (drivers.length) text += ` The main ${direction === "up" ? "drivers" : "reductions"}: ${drivers.map((c) => `${categoryLabel(c.key)} ${c.delta > 0 ? "+" : "-"}${formatINR(Math.abs(c.delta))}`).join(", ")}.`;
        if (merchDrivers.length) text += ` By merchant: ${merchDrivers.map((c) => `${c.key} ${c.delta > 0 ? "+" : "-"}${formatINR(Math.abs(c.delta))}${c.kind === "new" ? " (new)" : ""}`).join(", ")}.`;
        if (diff > 0 && topPayments.length) text += ` Largest single payments in those categories: ${topPayments.map((t) => `${formatINR(t.amount)} at ${t.merchant} on ${formatDateLong(t.date)}`).join("; ")}.`;
      }
      if (periods.partial) text += ` (${curName[0].toUpperCase() + curName.slice(1)} is still in progress, so it is compared with the same number of days.)`;
      if (sp.caveats.some((c) => c.startsWith("Your history starts"))) text += ` ${sp.caveats.find((c) => c.startsWith("Your history starts"))}`;
      return {
        intent: q.intent,
        text,
        facts: {
          period: curName,
          comparedWith: like,
          current: { from: periods.current.from, to: periods.current.to, spending: cur.net, refundsNetted: round2(cur.refunded + cur.unlinkedRefunds) },
          previous: { from: periods.previous.from, to: periods.previous.to, spending: prev.net },
          difference: diff,
          percentChange: pctChange,
          direction,
          categoryDrivers: drivers.map((c) => ({ category: c.key, now: c.current, before: c.previous, change: c.delta, changePct: c.pctChange })),
          merchantDrivers: merchDrivers.map((c) => ({ merchant: c.key, now: c.current, before: c.previous, change: c.delta, isNew: c.kind === "new" })),
          largestPayments: topPayments,
          caveats: sp.caveats,
          calculation,
        },
        calculation,
        table: { columns: ["Category", "Now", "Before", "Change"], rows: catMovers.slice(0, 6).map((c) => [categoryLabel(c.key), formatINR(c.current), formatINR(c.previous), `${c.delta >= 0 ? "+" : "-"}${formatINR(Math.abs(c.delta))}`]) },
      };
    }

    case "afford": {
      const f = getForecast(userId, { days: 30, planned: q.amount, asOf: today });
      const amount = q.amount!;
      if (f.expectedRemaining === null) {
        return { intent: q.intent, text: `I can't judge affordability because your statements have no balance information. Your expected net cash flow over the next 30 days (income - recurring bills - typical everyday spending) is about ${formatINR(f.expectedNet + amount)}, before the ${formatINR(amount)} you're considering.`, facts: { amount, expectedNetBeforePlanned: f.expectedNet + amount } };
      }
      const after = f.expectedRemaining;
      const verdict = after - f.buffer >= 0 ? (after - f.buffer > amount * 0.25 ? "looks affordable" : "looks tight but possible") : "may not be affordable";
      return forecastAnswer(q.intent, f, "over the next 30 days", `**Spending ${formatINR(amount)} ${verdict}** based on your historical cash flow - after it, I'd estimate about ${formatINR(after)} remaining (range ${formatINR(f.expectedRemainingLow ?? after)} to ${formatINR(f.expectedRemainingHigh ?? after)}). This is an estimate, not a guarantee.`, { planned: amount, verdict });
    }

    case "remaining_after_bills": {
      const f = getForecast(userId, { days: 30, asOf: today });
      let items = f.upcoming.filter((u) => u.kind === "expense");
      let scope = "all expected bills in the next 30 days";
      if (q.named.length) {
        const words = q.named.map((n) => (n === "wifi" || n === "broadband" ? "internet" : n === "phone" ? "mobile" : n));
        const picked = items.filter((u) => words.some((w) => `${u.name} ${u.category}`.toLowerCase().includes(w) || (w === "rent" && u.category === "RENT") || (w === "electricity" && /electric|bescom|power/i.test(u.name))));
        if (picked.length) {
          items = picked;
          scope = `only ${[...new Set(picked.map((p) => p.name))].join(" and ")}`;
        }
      }
      const billTotal = round2(sum(items.map((u) => u.amount)));
      const bal = f.currentBalance;
      if (bal === null) return noDataAnswer(q.intent, `Your statements have no balance information, so I can't compute what would remain. The expected bills (${scope}) total about ${formatINR(billTotal)}.`);
      const remaining = round2(bal - billTotal);
      return {
        intent: q.intent,
        text: `**Current balance:** ${formatINR(bal)} (as of ${f.balanceAsOf ? formatDateLong(f.balanceAsOf) : "the last statement"})\n**Expected bills (${scope}):** ${formatINR(billTotal)}\n**Remaining after those bills:** **${formatINR(remaining)}**\nThis ignores any income arriving in the period (${formatINR(f.expectedIncome)} expected) and everyday spending (about ${formatINR(f.discretionary.expected)} estimated), so it is a conservative floor. All expected items are estimates.`,
        facts: { currentBalance: bal, expectedBills: billTotal, remainingAfterBills: remaining, scope, expectedIncome: f.expectedIncome, estimatedDiscretionary: f.discretionary.expected, items: items.map((i) => ({ name: i.name, amount: i.amount, date: i.date, source: i.source })) },
        table: { columns: ["Expected", "Bill", "Amount (est.)"], rows: items.map((i) => [i.date, i.name, formatINR(i.amount)]) },
      };
    }

    case "cash_requirement": {
      const next = financialMonthRange(addMonths(thisMonth.from, 1, msd > 1 ? msd : 1), msd);
      const fromDate = next.from > today ? next.from : today;
      const series = detectSeries(userId, today);
      const items = buildUpcoming({ asOf: fromDate, to: next.to, series, manual: getManualObligations(userId), dismissedKeys: getDismissedKeys(userId) }).filter((i) => i.kind === "expense");
      const recurring = round2(sum(items.map((i) => i.amount)));
      const f = getForecast(userId, { to: next.to, asOf: today });
      const discPerDay = f.discretionary.dailyAverage;
      const days = daysBetween(next.from, next.to) + 1;
      const disc = round2(discPerDay * days);
      return {
        intent: q.intent,
        text: `For next month (${describeRange(next.from, next.to)}) I estimate you'll need roughly **${formatINR(recurring + disc)}**: about ${formatINR(recurring)} in expected recurring bills plus about ${formatINR(disc)} of everyday spending at your recent pace (${formatINR(discPerDay)}/day). These are estimates from historical patterns.`,
        facts: { period: { from: next.from, to: next.to }, expectedRecurring: recurring, estimatedDiscretionary: disc, estimatedCashRequirement: round2(recurring + disc), items: items.map((i) => ({ name: i.name, amount: i.amount, date: i.date })) },
        table: { columns: ["Expected", "Payment", "Amount (est.)"], rows: items.map((i) => [i.date, i.name, formatINR(i.amount)]) },
      };
    }

    default:
      return {
        intent: "unknown",
        text: "I can answer questions about your imported transactions - spending by category or merchant, income, recurring payments, upcoming bills, comparisons between periods, unusual transactions, and estimates like how much you can safely spend. Try one of the suggestions below.",
        facts: { understood: false },
        suggestions: HELP_SUGGESTIONS,
      };
  }
}

function forecastAnswer(intent: Intent, f: ReturnType<typeof getForecast>, span: string, headline?: string, extra: Record<string, unknown> = {}): Answer {
  const lines = [
    headline ?? (f.safeToSpend !== null ? `Based on your historical cash flow, I estimate you could safely spend about **${formatINR(f.safeToSpend)}** more ${span}, after expected bills and a small safety buffer.` : `I can't compute a safe-to-spend amount without balance information, but the expected net cash flow ${span} is about ${formatINR(f.expectedNet)}.`),
    "",
    `**Current balance:** ${f.currentBalance === null ? "unknown" : formatINR(f.currentBalance)}`,
    `**Expected income:** ${formatINR(f.expectedIncome)} (estimate)`,
    `**Expected recurring expenses:** ${formatINR(f.expectedRecurring)} (estimate)`,
    `**Estimated everyday spending:** ${formatINR(f.discretionary.expected)} (range ${formatINR(f.discretionary.low)}–${formatINR(f.discretionary.high)})`,
    `**Estimated remaining cash:** ${f.expectedRemaining === null ? "n/a" : formatINR(f.expectedRemaining)}`,
    "",
    `Assumptions: ${f.assumptions.slice(0, 2).join(" ")} Forecasts are estimates, not guarantees.`,
  ];
  return {
    intent,
    text: lines.join("\n"),
    facts: {
      currentBalance: f.currentBalance,
      balanceAsOf: f.balanceAsOf,
      expectedIncome: f.expectedIncome,
      expectedRecurring: f.expectedRecurring,
      estimatedDiscretionary: f.discretionary.expected,
      estimatedDiscretionaryLow: f.discretionary.low,
      estimatedDiscretionaryHigh: f.discretionary.high,
      estimatedRemaining: f.expectedRemaining,
      estimatedRemainingLow: f.expectedRemainingLow,
      estimatedRemainingHigh: f.expectedRemainingHigh,
      safetyBuffer: f.buffer,
      safeToSpend: f.safeToSpend,
      horizonDays: f.horizonDays,
      until: f.to,
      confidence: f.confidence,
      ...extra,
    },
    table: { columns: ["Expected", "Payment", "Amount (est.)"], rows: f.upcoming.filter((u) => u.kind === "expense").slice(0, 12).map((u) => [u.date, u.name, formatINR(u.amount)]) },
  };
}
