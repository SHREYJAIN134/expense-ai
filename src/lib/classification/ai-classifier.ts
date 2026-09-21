/**
 * AI classification for the transactions the deterministic pipeline could not place.
 *
 * PRIVACY: only a cleaned merchant/narration snippet (no amounts, dates, account
 * numbers, references, VPAs, balances) and the debit/credit direction leave the
 * server. Raw PDFs never do. If no key is configured, or the call fails, rows
 * simply stay OTHER / Unclassified - the import is never blocked.
 */
import { CATEGORIES, UNCLASSIFIED } from "../domain/categories";
import type { Classification, NormalizedTransaction } from "../domain/types";
import { AiError, extractJson, type AiProvider } from "../ai/provider";
import { keywordText } from "./classifier";

type Row = NormalizedTransaction & Classification;

const AI_CONFIDENCE_CAP = 0.8;
const BATCH = 40;
const MAX_BATCHES = 5;
export const AI_THRESHOLD = 0.5;

const TAXONOMY = CATEGORIES.map((c) => `${c.name}: ${c.subcategories.join(" | ")}`).join("\n");

const SYSTEM = `You classify Indian bank-statement transactions into a fixed taxonomy.
You only see a merchant name and a short cleaned narration - never amounts or account data.
Respond with ONLY a JSON array: [{"k":<number>,"category":"...","subcategory":"...","confidence":0-1}].
Use category and subcategory names EXACTLY as listed. If genuinely unsure use category "OTHER" and confidence <= 0.4.
Never invent facts; person-to-person UPI names are TRANSFERS / Person Transfer.

Taxonomy (CATEGORY: subcategories):
${TAXONOMY}`;

export function needsAi(r: Classification): boolean {
  return r.method === "none" && r.confidence < AI_THRESHOLD;
}

export interface AiRefineResult {
  attempted: boolean;
  applied: number;
  failed: boolean;
  error?: string;
}

export async function refineWithAi(rows: Row[], provider: AiProvider | null): Promise<AiRefineResult> {
  // Counterparties that may be people (semanticType set by the Google Pay normaliser) are never sent anywhere.
  const pending = rows.filter((r) => needsAi(r) && !r.semanticType);
  if (!provider || pending.length === 0) return { attempted: false, applied: 0, failed: false };

  // One query per distinct merchant.
  const groups = new Map<string, Row[]>();
  for (const r of pending) {
    const arr = groups.get(r.merchantKey) ?? [];
    arr.push(r);
    groups.set(r.merchantKey, arr);
  }
  const entries = [...groups.entries()].slice(0, BATCH * MAX_BATCHES);
  let applied = 0;

  try {
    for (let i = 0; i < entries.length; i += BATCH) {
      const chunk = entries.slice(i, i + BATCH);
      const payload = chunk.map(([, rs], k) => {
        const r = rs[0];
        return {
          k,
          merchant: r.merchant,
          narration: keywordText(r).slice(0, 80),
          direction: r.direction,
        };
      });
      const text = await provider.complete({
        system: SYSTEM,
        user: `Classify these ${payload.length} transactions:\n${JSON.stringify(payload)}`,
        maxTokens: 2000,
        temperature: 0,
      });
      const parsed = extractJson<{ k: number; category: string; subcategory?: string; confidence?: number }[]>(text);
      if (!Array.isArray(parsed)) throw new AiError("AI response was not a JSON array");
      for (const item of parsed) {
        const entry = chunk[item?.k as number];
        if (!entry) continue;
        const cat = CATEGORIES.find((c) => c.name === item.category);
        if (!cat || cat.name === UNCLASSIFIED.category) continue;
        const sub = cat.subcategories.includes(item.subcategory ?? "") ? (item.subcategory as string) : cat.subcategories[0];
        const conf = Math.min(AI_CONFIDENCE_CAP, Math.max(0.3, Number(item.confidence) || 0.5));
        for (const r of entry[1]) {
          r.category = cat.name;
          r.subcategory = sub;
          r.confidence = conf;
          r.method = "ai";
          r.reason = "AI-suggested (review recommended)";
          applied++;
        }
      }
    }
    return { attempted: true, applied, failed: false };
  } catch (e) {
    // Fail soft: leave rows as OTHER / Unclassified.
    return { attempted: true, applied, failed: true, error: e instanceof Error ? e.message : "AI classification failed" };
  }
}
