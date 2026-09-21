/**
 * Optional LLM phrasing layer. The model receives ONLY the already-computed
 * facts (never raw transactions or PDFs; identifiers are stripped and people's names are replaced by placeholders,
 * see privacy.ts) and is told not to introduce numbers.
 * A verifier then rejects any response containing a number that isn't in the
 * facts; in that case (or on any failure) the deterministic answer is used.
 */
import { getAiProvider, type AiProvider } from "../ai/provider";
import type { Answer } from "./answer";
import { buildAiPayload, Redactor } from "./privacy";

const SYSTEM = `You are Expense AI Assistant, a careful personal-finance explainer.
You are given a user's QUESTION, structured FACTS computed from their bank data, and a DRAFT answer.
Rewrite the DRAFT as a clear, friendly answer of at most 6 short sentences or bullet lines.
STRICT RULES:
- Use ONLY numbers, dates, names and amounts that appear in FACTS or DRAFT. Never calculate new figures, never estimate, never invent transactions.
- Keep amounts in the ₹ format used in the DRAFT.
- Anything forecast-like must stay labelled as an estimate / expected / based on historical pattern - never as guaranteed.
- Do not give investment or tax advice. If data is missing, say so plainly.
- Never explain causes, trends or insights that are not stated in FACTS or DRAFT. Never call anything fraud or suspicious: use the words "unusual activity", which only means different from the person's normal pattern.
- Do not repeat placeholders such as "Person 1" differently; keep them exactly as written.
- Preserve labelled sections (e.g. CURRENT BALANCE / EXPECTED INCOME) if the DRAFT has them.`;

const NUM_RE = /\d[\d,]*(?:\.\d+)?/g;

function collectNumbers(text: string, into: number[]) {
  for (const m of text.matchAll(NUM_RE)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) into.push(n);
  }
}

/** True if every number in `candidate` is present (within rounding) in the facts or draft. */
export function numbersAreGrounded(candidate: string, facts: unknown, draft: string): boolean {
  const allowed: number[] = [];
  collectNumbers(JSON.stringify(facts), allowed);
  collectNumbers(draft, allowed);
  const found: number[] = [];
  collectNumbers(candidate, found);
  return found.every((n) => {
    if (Number.isInteger(n) && n <= 31) return true; // day numbers, small counts
    if (n >= 1900 && n <= 2100 && Number.isInteger(n)) return true; // years
    return allowed.some((a) => Math.abs(a - n) <= Math.max(1, Math.abs(a) * 0.005));
  });
}

export async function narrate(
  question: string,
  answer: Answer,
  enabled: boolean,
  opts: { provider?: AiProvider | null; /** names of people the user paid; never sent to the provider */ redactNames?: string[] } = {},
): Promise<{ text: string; usedLlm: boolean }> {
  const provider = enabled ? (opts.provider === undefined ? getAiProvider() : opts.provider) : null;
  // Transaction lists are shown exactly as the database returned them: a rewrite could drop or reorder rows.
  if (!provider || answer.noData || answer.intent === "unknown" || answer.intent === "transaction_list") return { text: answer.text, usedLlm: false };
  try {
    // Minimum structured context: sanitised facts + draft + question, with identifiers masked and people redacted.
    const redactor = new Redactor(opts.redactNames ?? []);
    const payload = buildAiPayload(question, answer.facts, answer.text, redactor);
    const out = await provider.complete({
      system: SYSTEM,
      user: `QUESTION: ${payload.question}

FACTS (JSON): ${payload.facts}

DRAFT: ${payload.draft}`,
      maxTokens: 500,
      temperature: 0.2,
    });
    const text = redactor.restore(out.trim());
    if (!text || text.length > 2500 || !numbersAreGrounded(text, answer.facts, answer.text)) return { text: answer.text, usedLlm: false };
    return { text, usedLlm: true };
  } catch {
    return { text: answer.text, usedLlm: false };
  }
}
