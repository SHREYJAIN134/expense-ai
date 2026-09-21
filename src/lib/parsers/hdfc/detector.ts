import type { PdfPage } from "../pdf-reader";
import { findHeader, groupLines } from "./layout";

export interface Detection {
  isHdfc: boolean;
  /** True when the parser that produced this detection recognises the document as its own format. */
  matched: boolean;
  hasTable: boolean;
  confidence: number;
  reasons: string[];
}

/**
 * Decide whether the extracted PDF looks like an HDFC account statement.
 * We do not require a perfect match: HDFC has shipped several layouts, so we
 * combine weak signals (brand text, statement wording, a recognisable column
 * header). The parser can still run in fallback mode when there is no table.
 */
export function detectHdfc(pages: PdfPage[]): Detection {
  const reasons: string[] = [];
  let score = 0;
  const allText = pages
    .slice(0, 2)
    .map((p) => p.items.map((i) => i.str).join(" "))
    .join(" ")
    .toLowerCase();

  if (/hdfc\s*bank/.test(allText)) {
    score += 0.45;
    reasons.push("HDFC Bank branding");
  }
  if (/statement\s+of\s+account|account\s+statement|statement\s+from|statement\s+period/.test(allText)) {
    score += 0.15;
    reasons.push("statement wording");
  }
  if (/hdfc0\d{6}|hdfc bank limited|hdfcbank\.com/.test(allText)) {
    score += 0.1;
    reasons.push("HDFC IFSC / legal footer");
  }
  let hasTable = false;
  for (const p of pages) {
    if (findHeader(groupLines(p))) {
      hasTable = true;
      break;
    }
  }
  if (hasTable) {
    score += 0.3;
    reasons.push("transaction table header found");
  }
  const isHdfc = score >= 0.45 && (hasTable || /hdfc/.test(allText));
  return { isHdfc, matched: isHdfc, hasTable, confidence: Math.min(1, score), reasons };
}
