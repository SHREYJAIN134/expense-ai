import { categoryLabel, CATEGORY_COLOR } from "../domain/categories";
import { formatINR } from "../util/money";
import { MONTH_SHORT, parseISO } from "../util/dates";

export { formatINR as inr, categoryLabel };

/** ₹1.2L / ₹45k / ₹850 - compact, Indian-style, for axes and tight spaces. */
export function inrCompact(n: number): string {
  const a = Math.abs(n);
  const s = n < 0 ? "-" : "";
  if (a >= 1e7) return `${s}₹${(a / 1e7).toFixed(a >= 1e8 ? 0 : 1).replace(/\.0$/, "")}Cr`;
  if (a >= 1e5) return `${s}₹${(a / 1e5).toFixed(a >= 1e6 ? 0 : 1).replace(/\.0$/, "")}L`;
  if (a >= 1e3) return `${s}₹${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1).replace(/\.0$/, "")}k`;
  return `${s}₹${Math.round(a)}`;
}

export function shortDate(iso: string): string {
  const d = parseISO(iso);
  return `${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]}`;
}
export function longDate(iso: string): string {
  const d = parseISO(iso);
  return `${d.getUTCDate()} ${MONTH_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export const catColor = (c: string) => CATEGORY_COLOR[c] ?? "#94a3b8";

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase())
    .join("");
}

export function confidenceLabel(c: number): { text: string; tone: "pos" | "warn" | "neg" } {
  if (c >= 0.85) return { text: "High", tone: "pos" };
  if (c >= 0.6) return { text: "Medium", tone: "warn" };
  return { text: "Low", tone: "neg" };
}

export const METHOD_LABEL: Record<string, string> = {
  user: "Your correction",
  rule: "Rule",
  merchant: "Known merchant",
  history: "History",
  keyword: "Keyword",
  ai: "AI suggestion",
  recurring: "Recurring pattern",
  none: "Unclassified",
};
