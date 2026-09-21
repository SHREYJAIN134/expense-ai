/**
 * Turns the two deterministic feeds (unusual-activity findings and rule-based insights) into one chronological list of
 * "signals". Nothing is generated here: every title, explanation and number comes from the server-side analytics.
 */
import type { UnusualActivity } from "../analytics/anomalies";
import type { IntelInsight } from "../analytics/intelligence";

export type SignalKind = "Unusual activity" | "Worth a check" | "Pattern" | "Coming up" | "About your data" | "Good to know";
export type SignalGroup = "unusual" | "pattern" | "upcoming" | "note";

export interface LedgerSignal {
  id: string;
  date: string;
  kind: SignalKind;
  group: SignalGroup;
  /** Draws the highlighter: something that deserves the user's eye. */
  highlight: boolean;
  title: string;
  body: string;
  /** How it was calculated, verbatim from the analytics layer. */
  calculation: string;
  confidence: number | null;
  txnIds: string[];
  merchants: string[];
  categories: string[];
  /** Where "View rows" should go. */
  href: string;
  /** Only present for unusual-activity findings; used for evidence sparklines. */
  anomaly?: UnusualActivity;
  insight?: IntelInsight;
}

const SKIP_KINDS = new Set<IntelInsight["kind"]>(["unusual_activity", "large_transaction"]);

function insightKind(i: IntelInsight): { kind: SignalKind; group: SignalGroup } {
  switch (i.kind) {
    case "upcoming_recurring":
    case "recurring_detected":
      return { kind: "Coming up", group: "upcoming" };
    case "stale_data":
      return { kind: "About your data", group: "note" };
    case "budget":
    case "negative_cashflow":
    case "high_discretionary":
      return { kind: "Worth a check", group: "pattern" };
    case "positive_cashflow":
    case "spending_down":
    case "category_drop":
      return { kind: "Good to know", group: "pattern" };
    default:
      return { kind: "Pattern", group: "pattern" };
  }
}

function ledgerHref(p: { txnIds: string[]; merchants?: string[]; categories?: string[]; date: string }): string {
  const sp = new URLSearchParams();
  if (p.txnIds.length === 1) sp.set("open", p.txnIds[0]);
  else if (p.merchants?.length === 1) sp.set("merchant", p.merchants[0]);
  else if (p.categories?.length === 1) sp.set("category", p.categories[0]);
  else {
    sp.set("from", p.date);
    sp.set("to", p.date);
  }
  return `/ledger?${sp.toString()}`;
}

export function buildSignals(anomalies: UnusualActivity[], insights: IntelInsight[]): LedgerSignal[] {
  const out: LedgerSignal[] = [];
  for (const a of anomalies) {
    const dup = a.type === "possible_duplicate";
    out.push({
      id: `a:${a.id}`,
      date: a.date,
      kind: dup ? "Worth a check" : "Unusual activity",
      group: "unusual",
      highlight: a.severity !== "low",
      title: a.reason,
      body: a.baselineLabel.charAt(0).toUpperCase() + a.baselineLabel.slice(1) + ". Unusual only means different from your own pattern.",
      calculation: `${a.unit === "count" ? `${a.observed} payments` : `₹${a.observed.toLocaleString("en-IN")}`} observed vs ${a.baselineLabel} from ${a.sampleSize} earlier observation${a.sampleSize === 1 ? "" : "s"}${a.ratio ? ` (${Math.round(a.ratio * 10) / 10}×)` : ""}.`,
      confidence: a.confidence,
      txnIds: a.txnIds,
      merchants: a.merchant ? [a.merchant] : [],
      categories: a.category ? [a.category] : [],
      href: ledgerHref({ txnIds: a.txnIds, merchants: a.merchant ? [a.merchant] : [], categories: a.category ? [a.category] : [], date: a.date }),
      anomaly: a,
    });
  }
  for (const i of insights) {
    if (SKIP_KINDS.has(i.kind)) continue;
    const { kind, group } = insightKind(i);
    out.push({
      id: `i:${i.id}`,
      date: i.date,
      kind,
      group,
      highlight: i.severity === "attention",
      title: i.title,
      body: i.explanation,
      calculation: i.calculation,
      confidence: null,
      txnIds: i.txnIds,
      merchants: i.merchants,
      categories: i.categories,
      href: ledgerHref({ txnIds: i.txnIds, merchants: i.merchants, categories: i.categories, date: i.date }),
      insight: i,
    });
  }
  const weight = (s: LedgerSignal) => (s.highlight ? 0 : 1);
  return out.sort((a, b) => (a.date === b.date ? weight(a) - weight(b) : a.date < b.date ? 1 : -1));
}

/** The few worth surfacing on Now: highlighted first, then the newest. */
export function topSignals(all: LedgerSignal[], n = 4): LedgerSignal[] {
  return [...all].sort((a, b) => Number(b.highlight) - Number(a.highlight) || (a.date < b.date ? 1 : -1)).slice(0, n);
}
