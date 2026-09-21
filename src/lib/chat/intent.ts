/**
 * Question understanding. Deliberately deterministic: the *intent and parameters*
 * are extracted with rules, the *numbers* come from the analytics layer, and an
 * LLM (if configured) only phrases the result. It never chooses what data to trust.
 */
import { CATEGORIES } from "../domain/categories";
import { KNOWN_MERCHANTS } from "../classification/merchants";
import { formatDateLong, type ISODate } from "../util/dates";
import { resolvePeriod, type ResolvedPeriod } from "./period";

export type Intent =
  | "spend_category" | "spend_merchant" | "spend_total" | "income_total" | "biggest_expense"
  | "recurring_list" | "upcoming_payments" | "monthly_average" | "safe_to_spend" | "afford"
  | "remaining_after_bills" | "cash_requirement" | "compare_periods" | "spending_trend"
  | "top_categories" | "anomalies" | "balance" | "historical_balance" | "transaction_list"
  | "busiest_day" | "top_spending_day" | "top_income_day" | "top_value_day" | "largest_transaction" | "top_merchants" | "top_spending_period"
  | "why_spending_changed" | "categories_changed" | "unknown";

export interface ParsedQuery {
  intent: Intent;
  period: ResolvedPeriod | null;
  category?: string;
  subcategory?: string;
  merchant?: string;
  amount?: number;
  days?: number;
  /** words like "rent", "electricity" named in a "if I pay X and Y" question */
  named: string[];
  followUp: boolean;
  /** For "why did my spending go up/down": the direction the user assumed, so a false premise can be corrected. */
  asked?: "up" | "down";
  /** Transaction lists: only debits / only credits (undefined = both). */
  direction?: "debit" | "credit";
  /** The question contained an impossible date or an ambiguous year: answered with the message, never guessed. */
  dateProblem?: { kind: "error" | "clarify"; message: string };
  /** Ranking questions: what to rank merchants by, which period grain, and whether "income" was asked strictly. */
  rankBy?: "amount" | "count";
  grain?: "weekly" | "monthly";
  strictIncome?: boolean;
  /** Genuinely ambiguous question: ask which one is meant instead of guessing. */
  clarification?: { message: string; suggestions: string[] };
}

export interface QueryContext {
  today: ISODate;
  monthStartDay: number;
  merchants: string[];
  /** Span of the imported data: lets "24th of August" pick the statement's year when only one fits. */
  dataRange?: { from: ISODate; to: ISODate } | null;
  last?: { intent: Intent; category?: string; subcategory?: string; merchant?: string; direction?: "debit" | "credit"; period?: ResolvedPeriod | null; /** day(s) the previous answer was about ("that day") */ focusDates?: ISODate[] };
}

/**
 * Follow-ups ("what about last month?") may only inherit an intent that is parameterised by a period / category /
 * merchant. Inheriting "balance" or a forecast would answer a different question than the one asked.
 */
const FOLLOW_UP_OK = new Set<Intent>([
  "spend_category", "spend_merchant", "spend_total", "income_total", "biggest_expense", "top_categories", "compare_periods",
  "spending_trend", "transaction_list", "why_spending_changed", "categories_changed", "anomalies",
  "busiest_day", "top_spending_day", "top_income_day", "top_value_day", "largest_transaction", "top_merchants", "top_spending_period",
]);

/** Words that make a question analytical rather than a request to list transactions. */
const ANALYTIC_RE = /\b(biggest|largest|highest|top|most expensive|costliest|unusual|anomal\w*|suspicious|outliers?|recurring|upcoming|coming up|due|expected|average|compare|comparison|trend|increase[ds]?|decrease[ds]?|subscriptions?)\b|\bhow much\b|\btotal\b/;

/** Direction of a transaction list: received/credits = money in; debits/payments/purchases/spent = money out. */
export function detectDirection(t: string): "debit" | "credit" | undefined {
  if (/\b(credits?|received?|receive|incoming|deposits?|money in|came in)\b/.test(t)) return "credit";
  if (/\b(debits?|paid|pay|payments?|purchases?|purchased|spen[dt]|expenses?|bought|outgoing|money out|sent)\b/.test(t)) return "debit";
  return undefined;
}

type Ranking = { intent: Intent; rankBy?: "amount" | "count"; grain?: "weekly" | "monthly"; strictIncome?: boolean; direction?: "debit" | "credit"; clarification?: ParsedQuery["clarification"] };

/**
 * Superlative questions: "which day had the most transactions", "largest transaction", "top merchants"...
 * Decided BEFORE lists and summaries so "what day had the most transactions" is never mistaken for a list request.
 */
export function detectRanking(t: string): Ranking | null {
  const hasDay = /\b(day|date)\b/.test(t);
  const superlative = /\b(most|highest|maximum|max|greatest|largest|biggest|busiest|top|peak|costliest|most expensive)\b/.test(t);
  if (!superlative) return null;
  // --- by day
  if (hasDay || /\bbusiest\b/.test(t)) {
    if (/\b(transaction|txn|payment)s?\s+(amount|value|volume)\b|\btotal (transaction )?(amount|value)\b|\bamount of (the )?transactions\b|\bmoney moved\b|\bvalue of (all )?transactions\b/.test(t)) return { intent: "top_value_day" };
    if (/\bbusiest\b|\bnumber of (transactions?|payments?|txns?)\b|\b(transaction|payment) (count|activity)\b|\bactivity\b|\bmost (transactions?|payments?|txns?)\b|\bmost active\b|\bhow many\b/.test(t)) return { intent: "busiest_day" };
    if (/\b(receive[ds]?|income|credited|money in|came in|earn(ed)?|incoming|deposit(ed|s)?)\b/.test(t)) return { intent: "top_income_day", strictIncome: /\b(income|salary|earn(ed)?)\b/.test(t) };
    if (/\b(spen[dt]|spending|expenses?|paid|pay|purchases?)\b/.test(t)) return { intent: "top_spending_day" };
  }
  // "highest transaction amount" with no "day": is it one transaction or a day's total? Ask.
  if (!hasDay && /\b(highest|maximum|max)\s+(transaction\s+)?amount\b/.test(t) && !/\b(single|one|individual|largest|biggest)\b/.test(t)) {
    return {
      intent: "largest_transaction",
      clarification: {
        message: 'By "highest transaction amount" do you mean the largest SINGLE transaction, or the day with the highest TOTAL transaction value?',
        suggestions: ["What was my largest single transaction?", "Which day had the highest total transaction value?"],
      },
    };
  }
  // --- single largest transaction (any direction); "expense/purchase/spend/debit" keeps the older spending-only answer
  if (!hasDay && /\b(largest|biggest|highest|maximum|max|greatest|top)\b.*\b(single\s+)?(transactions?|txns?)\b/.test(t) && !/\b(expense|expenses|purchase|purchases|spend|spent|spending|debit)\b/.test(t)) {
    return { intent: "largest_transaction", direction: /\b(credit|received|deposit|incoming|money in)\b/.test(t) ? "credit" : undefined };
  }
  if (!hasDay && /\b(largest|biggest|highest|greatest|top)\b.*\b(credit|deposit|incoming|amount i received|amount received)\b/.test(t)) return { intent: "largest_transaction", direction: "credit" };
  // --- merchants
  if (/\btop\b.*\bmerchants?\b|\b(which|what)\b.*\bmerchants?\b.*\b(most|highest|top|often|frequent)|\bmost (frequent|common|visited|used)\s+merchants?\b|\bmerchants?\b.*\b(spen[dt]|paid) the most\b|\bwho did i (spend|pay) the most\b/.test(t)) {
    return { intent: "top_merchants", rankBy: /\b(often|frequent|frequently|visited|most transactions|number of|most used)\b/.test(t) ? "count" : "amount" };
  }
  // --- weeks / months
  if (!hasDay) {
    const wm = t.match(/\b(?:which|what)\s+(week|month)\b|\b(?:highest|top|biggest|most expensive|costliest|peak)\s+(?:spending\s+)?(week|month)\b|\b(week|month)\s+(?:i|did i)\s+spen[dt]\b/);
    if (wm && /\b(spen[dt]|spending|expensive|costliest)\b/.test(t)) return { intent: "top_spending_period", grain: (wm[1] ?? wm[2] ?? wm[3]) === "week" ? "weekly" : "monthly" };
  }
  return null;
}

/** "list all the transaction on 24th of august" - a request for the transactions themselves. */
function asksForTransactionList(t: string, hasPeriod: boolean, hasSubject: boolean): boolean {
  if (ANALYTIC_RE.test(t) && !/\bhow many\b/.test(t)) return false;
  const verb = /\b(list|show|display|give|see|view|find|get|fetch)\b/.test(t);
  const noun = /\b(transactions?|txns?|payments?|purchases?|credits?|debits?|transfers?)\b/.test(t);
  if (verb && noun) return true;
  if (/\bwhat\b.*\b(all )?(the )?(transactions?|payments?|purchases?)\b/.test(t) && !/\bwhat is\b.*\btotal\b/.test(t)) return true;
  if (/\b(transactions?|txns?|payments?|purchases?)\s+(on|from|between|during|for|of|in|at)\b/.test(t)) return true;
  if (/\bhow many\b.*\b(transactions?|payments?|purchases?)\b/.test(t)) return true;
  // "what did I spend yesterday?" / "what did I receive on August 24?" - a period but no category or merchant
  if (hasPeriod && !hasSubject && /\bwhat\b.*\b(did|have)\s+i\s+(spend|spent|pay|paid|buy|bought|purchase|receive|received|get|got)\b/.test(t)) return true;
  return false;
}

const CATEGORY_SYNONYMS: Record<string, string> = {
  food: "FOOD", dining: "FOOD", restaurant: "FOOD", restaurants: "FOOD", "eating out": "FOOD", takeout: "FOOD", "food delivery": "FOOD",
  groceries: "GROCERIES", grocery: "GROCERIES",
  transport: "TRANSPORTATION", transportation: "TRANSPORTATION", commute: "TRANSPORTATION", commuting: "TRANSPORTATION", fuel: "TRANSPORTATION", petrol: "TRANSPORTATION", cab: "TRANSPORTATION", cabs: "TRANSPORTATION", uber: "TRANSPORTATION",
  shopping: "SHOPPING", clothes: "SHOPPING", clothing: "SHOPPING",
  entertainment: "ENTERTAINMENT", movies: "ENTERTAINMENT", streaming: "ENTERTAINMENT", games: "ENTERTAINMENT", gaming: "ENTERTAINMENT",
  education: "EDUCATION", courses: "EDUCATION", learning: "EDUCATION", books: "EDUCATION",
  subscriptions: "SUBSCRIPTIONS", subscription: "SUBSCRIPTIONS",
  utilities: "UTILITIES", utility: "UTILITIES", electricity: "UTILITIES", internet: "UTILITIES", "mobile bill": "UTILITIES", broadband: "UTILITIES",
  rent: "RENT",
  health: "HEALTHCARE", healthcare: "HEALTHCARE", medical: "HEALTHCARE", medicine: "HEALTHCARE", medicines: "HEALTHCARE", pharmacy: "HEALTHCARE",
  travel: "TRAVEL", flights: "TRAVEL", hotels: "TRAVEL", trips: "TRAVEL",
  bills: "BILLS", insurance: "BILLS", emi: "BILLS",
  personal: "PERSONAL", gym: "PERSONAL", fitness: "PERSONAL",
  transfers: "TRANSFERS", transfer: "TRANSFERS",
  atm: "ATM/CASH", cash: "ATM/CASH",
  fees: "BANKING FEES", charges: "BANKING FEES", "bank charges": "BANKING FEES",
  investments: "INVESTMENTS", investing: "INVESTMENTS", sip: "INVESTMENTS",
  refunds: "REFUNDS", refund: "REFUNDS",
};

const SUB_LOOKUP: { sub: string; cat: string; word: string }[] = CATEGORIES.flatMap((c) =>
  c.subcategories.filter((s) => s !== "Unclassified").map((s) => ({ sub: s, cat: c.name, word: s.toLowerCase() })),
);

export function detectCategory(q: string): { category?: string; subcategory?: string } {
  const t = q.toLowerCase();
  // sub-category names first ("food delivery", "electricity"), longest word wins
  const subs = SUB_LOOKUP.filter((s) => new RegExp(`\\b${s.word.replace(/[&+]/g, "\\$&")}\\b`).test(t)).sort((a, b) => b.word.length - a.word.length);
  const syn = Object.keys(CATEGORY_SYNONYMS).filter((k) => new RegExp(`\\b${k}\\b`).test(t)).sort((a, b) => b.length - a.length);
  if (syn[0]) {
    const category = CATEGORY_SYNONYMS[syn[0]];
    const sub = subs.find((s) => s.cat === category);
    return { category, subcategory: sub?.sub };
  }
  for (const c of CATEGORIES) if (new RegExp(`\\b${c.name.toLowerCase().replace("/", "[ /]")}\\b`).test(t)) return { category: c.name };
  if (subs[0]) return { category: subs[0].cat, subcategory: subs[0].sub };
  return {};
}

export function detectMerchant(q: string, merchants: string[]): string | undefined {
  const t = q.toLowerCase();
  const candidates = new Set<string>([...merchants, ...KNOWN_MERCHANTS.map((m) => m.name)]);
  let best: string | undefined;
  for (const m of candidates) {
    const name = m.toLowerCase();
    if (name.length < 3) continue;
    const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(^|[^a-z0-9])${esc}(?![a-z0-9])`).test(t) || (name.includes(" ") === false && new RegExp(`(^|[^a-z0-9])${esc}s?(?![a-z0-9])`).test(t))) {
      if (!best || name.length > best.length) best = m;
    }
  }
  // prefer the user's own merchant spelling when only a known-merchant name matched
  if (best) {
    const own = merchants.find((m) => m.toLowerCase() === best!.toLowerCase());
    return own ?? best;
  }
  return undefined;
}

export function parseAmount(q: string): number | undefined {
  const unitMul = (u?: string) => {
    const x = (u ?? "").toLowerCase();
    return x === "k" || x === "thousand" ? 1000 : x === "l" || x === "lakh" || x === "lac" ? 100000 : 1;
  };
  let m = q.match(/(?:₹|\brs\.?|\binr)\s*([\d,]+(?:\.\d+)?)\s*(k|l|lakh|lac|thousand)?\b/i);
  if (!m) m = q.match(/\b(\d[\d,]*(?:\.\d+)?)\s*(k|lakh|lac|thousand)\b/i);
  if (!m) {
    // bare number >= 100, but not something that looks like a year
    const bare = [...q.matchAll(/\b(\d{1,3}(?:,\d{2,3})+|\d{3,})(?:\.\d+)?\b/g)].find((x) => !/^(19|20)\d{2}$/.test(x[1]));
    if (!bare) return undefined;
    m = [bare[0], bare[1]] as unknown as RegExpMatchArray;
  }
  const v = Number(m[1].replace(/,/g, "")) * unitMul(m[2]);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

const NAMED_BILLS = ["rent", "electricity", "internet", "wifi", "broadband", "mobile", "phone", "emi", "insurance", "netflix", "spotify", "gym", "water", "gas", "subscriptions", "sip"];

export function parseQuestion(question: string, ctx: QueryContext): ParsedQuery {
  const q = question.trim();
  const t = q.toLowerCase();
  const resolved = resolvePeriod(t, ctx.today, ctx.monthStartDay, ctx.dataRange ?? undefined);
  const dateProblem: ParsedQuery["dateProblem"] = resolved?.error ? { kind: "error", message: resolved.error } : resolved?.clarify ? { kind: "clarify", message: resolved.clarify } : undefined;
  let period = dateProblem ? null : resolved;
  let problem = dateProblem;
  // "show all transactions for that day": the day (or tied days) the previous answer was about
  if (/\b(that|the same) (day|date)\b/.test(t)) {
    const fd = ctx.last?.focusDates ?? [];
    if (fd.length === 1) period = { from: fd[0], to: fd[0], label: `on ${formatDateLong(fd[0])}`, kind: "past" };
    else if (fd.length > 1) problem = { kind: "clarify", message: `My last answer was about ${fd.length} days that tied (${fd.map(formatDateLong).join(", ")}). Which day do you mean? For example: "show all transactions on ${formatDateLong(fd[0])}".` };
    else problem = { kind: "clarify", message: "Which day do you mean? Tell me the date, for example \"show all transactions on 24 August\"." };
  }
  const { category, subcategory } = detectCategory(t);
  const merchant = detectMerchant(t, ctx.merchants);
  const amount = parseAmount(q);
  const daysMatch = t.match(/next\s+(\d{1,3})\s+days?/);
  const named = NAMED_BILLS.filter((b) => new RegExp(`\\b${b}\\b`).test(t));

  const has = (re: RegExp) => re.test(t);
  let intent: Intent = "unknown";

  // Precedence: superlative/ranking questions, then requests for the transactions THEMSELVES, then summaries, balances, forecasts.
  const isSingleDay = !!period && period.from === period.to;
  const ranking = problem ? null : detectRanking(t);
  if (ranking) intent = ranking.intent;
  else if (problem && has(/\b(transactions?|txns?|payments?|purchases?|credits?|debits?|balance|spen[dt]|how much)\b/)) intent = has(/\bbalance\b/) ? "historical_balance" : has(/\bhow much\b/) ? "spend_total" : "transaction_list";
  else if (asksForTransactionList(t, !!period, !!(category || merchant))) intent = "transaction_list";
  else if (has(/\bbalance\b/) && period && period.kind !== "all" && period.label !== "today" && (isSingleDay || has(/\b(was|on|at|as of|end of|by)\b/))) intent = "historical_balance";
  else if (has(/\b(can|could) i afford\b|\bafford\b|\bis it (ok|okay|safe|fine) to spend\b|\bcan i (spend|buy)\b/) && amount) intent = "afford";
  else if (has(/\bif i pay\b|\bafter (paying|i pay)\b|\bremain(ing)?\b.*\b(bills|rent|electricity|expected)|\bleft after\b|\b(how much|what).*(remain|left)\b.*\b(bills|expected|pay)/)) intent = "remaining_after_bills";
  else if (has(/\bsafe(ly)?\b.*\bspend\b|\bspend\b.*\bsafe(ly)?\b|\bhow much can i spend\b|\bspending (limit|room|power)\b/)) intent = "safe_to_spend";
  else if (has(/\bcash (requirement|needed|i need)\b|\bhow much (cash|money) (do i|will i) need\b|\bneed next month\b|\bestimated cash\b/)) intent = "cash_requirement";
  else if (has(/\bwhy\b.*\b(spending|spent|expenses?|money|bills?)\b|\bwhat (caused|drove|is driving|explains?)\b.*\b(spending|expenses?)\b/) && !has(/\bwhy\b.*\b(unusual|flagged)\b/)) intent = "why_spending_changed";
  else if (has(/\bcategor(y|ies)\b.*\b(increase[ds]?|went up|gone up|rose|risen|grew|grown|jumped|spiked)\b|\b(increase[ds]?|rose|grew|jumped|spiked)\b.*\bcategor(y|ies)\b|\bwhich\b.*\b(increased|went up|rose|grew)\b|\bwhat (increased|went up)\b/)) intent = "categories_changed";
  else if (has(/\bupcoming\b|\bcoming up\b|\bexpected (bills|payments|expenses)\b|\bbills (due|expected|in the next)|\bdue (soon|next)|\bwhat (bills|payments)\b.*\b(next|expected|due|coming)/)) intent = "upcoming_payments";
  else if (has(/\brecurring\b|\bsubscriptions?\b|\bregular (payments|bills|expenses)\b|\bmonthly (bills|payments|commitments)\b|\bautopay\b/) && !has(/\bhow much (did|have) i spen[dt]\b/)) intent = "recurring_list";
  else if (has(/\bunusual|\banomal|\bsuspicious|\boutlier|\bstrange\b|\bodd (transactions|payments)/)) intent = "anomalies";
  else if (has(/\bcompare\b|\bcomparison\b|\bversus\b|\bvs\.?\b|\bdifference\b/)) intent = "compare_periods";
  else if (has(/\b(did|has|have|is|was) my (spending|expenses)\b.*\b(increase|decrease|go up|gone up|gone down|rise|drop|change)|\bspending (increase|decrease|trend)|\bam i spending (more|less)|\bspending more\b|\bspending less\b/)) intent = "spending_trend";
  else if (has(/\b(biggest|largest|highest|top|most expensive|costliest)\b.*\b(expense|expenses|transaction|purchase|payment|spend|debit)/)) intent = "biggest_expense";
  else if (has(/\bwhere\b.*\b(money|spending)\b.*\b(going|go|went)|\bmost of my (money|spending)\b|\bspend the most\b|\btop (spending )?categor|\bmain expenses?\b|\bbreakdown\b/)) intent = "top_categories";
  else if (has(/\b(normally|usually|typically|on average|average)\b.*\b(spend|expenses)|\bmonthly average\b|\bevery month\b.*\bspend|\bspend every month\b|\baverage monthly\b/)) intent = "monthly_average";
  else if (has(/\b(came in|come in|came into|received|income|earn(ed)?|salary|credited|money in|incoming|inflow)\b/) && !has(/\bspen[dt]\b/)) intent = "income_total";
  else if (has(/\b(balance|how much (money )?do i have|how much is (in|left)|what.?s left)\b/) && !category && !merchant) intent = "balance";
  else if (merchant && has(/\bspen[dt]\b|\bpaid\b|\bpay\b|\bcost\b|\bspending\b|\bhow much\b|\btotal\b/)) intent = "spend_merchant";
  else if (category && has(/\bspen[dt]\b|\bpaid\b|\bspending\b|\bhow much\b|\btotal\b|\bcost\b/)) intent = "spend_category";
  else if (has(/\bhow much\b.*\bspen[dt]\b|\btotal (spend|spending|expenses)\b|\bmy (spending|expenses)\b|\bhow much did i (spend|pay)/)) intent = "spend_total";
  else if (merchant) intent = "spend_merchant";
  else if (category) intent = "spend_category";

  let followUp = false;
  const asked = has(/\b(increase[ds]?|higher|more|rise|risen|rose|jump(ed)?|gone up|go up|went up|up)\b/) ? "up" : has(/\b(decrease[ds]?|lower|less|drop(ped)?|fall|fell|gone down|go down|went down|down)\b/) ? "down" : undefined;
  const direction = intent === "transaction_list" ? detectDirection(t) : ranking?.direction;
  let out: ParsedQuery = { intent, period, category, subcategory, merchant, amount, days: daysMatch ? Number(daysMatch[1]) : undefined, named, followUp, asked, direction, dateProblem: problem, rankBy: ranking?.rankBy, grain: ranking?.grain, strictIncome: ranking?.strictIncome, clarification: ranking?.clarification };

  // Conversational memory: "what about last month?" / "and for Swiggy?" - only for intents that a period can re-parameterise.
  if (intent === "unknown" && !problem && ctx.last && FOLLOW_UP_OK.has(ctx.last.intent) && (period || category || merchant)) {
    followUp = true;
    out = {
      ...out,
      direction: ctx.last.direction,
      intent: ctx.last.intent,
      category: category ?? (merchant ? undefined : ctx.last.category),
      subcategory: subcategory ?? (category ? undefined : ctx.last.subcategory),
      merchant: merchant ?? (category ? undefined : ctx.last.merchant),
      period: period ?? ctx.last.period ?? null,
      followUp,
    };
    if (out.merchant && out.intent === "spend_category") out.intent = "spend_merchant";
    if (out.category && !out.merchant && out.intent === "spend_merchant") out.intent = "spend_category";
  }
  return out;
}
