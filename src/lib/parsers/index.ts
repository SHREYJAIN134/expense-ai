/**
 * Bank-parser registry. Adding a bank = implementing `BankParser` and adding it
 * to PARSERS; the rest of the pipeline only sees ParsedStatement.
 */
import { StatementError, type ParsedStatement } from "../domain/types";
import { readPdfPages, type PdfPage } from "./pdf-reader";
import { detectHdfc, type Detection } from "./hdfc/detector";
import { parseHdfcPages } from "./hdfc/parser";
import { normalizeTransactions, type NormalizeResult } from "./hdfc/normalizer";
import { detectGooglePay } from "./googlepay/detector";
import { parseGooglePayPages } from "./googlepay/parser";
import { normalizeGooglePay } from "./googlepay/normalizer";

export interface BankParser {
  id: string;
  label: string;
  detect(pages: PdfPage[]): Detection;
  parse(pages: PdfPage[]): ParsedStatement;
  /** Provider-specific normalisation into the canonical transaction model (defaults to the HDFC normaliser). */
  normalize?(statement: ParsedStatement): NormalizeResult;
}

export const PARSERS: BankParser[] = [
  { id: "hdfc", label: "HDFC Bank", detect: detectHdfc, parse: parseHdfcPages },
  { id: "googlepay", label: "Google Pay", detect: detectGooglePay, parse: parseGooglePayPages, normalize: normalizeGooglePay },
];

export interface ParsedUpload {
  statement: ParsedStatement;
  normalized: NormalizeResult;
  detection: Detection;
  parserId: string;
  pageCount: number;
}

/**
 * PDF bytes (+ optional password) -> parsed & normalized statement.
 * The password is used only inside readPdfPages and never retained.
 */
export async function parseStatementPdf(data: Uint8Array, password?: string): Promise<ParsedUpload> {
  const pages = await readPdfPages(data, password);
  if (!pages.some((p) => p.items.length > 0)) {
    throw new StatementError(
      "UNSUPPORTED_FORMAT",
      "The PDF contains no extractable text (it may be a scanned image). Only text-based bank statements are supported.",
    );
  }
  let best: { parser: BankParser; detection: Detection } | null = null;
  for (const parser of PARSERS) {
    const detection = parser.detect(pages);
    if (detection.matched && (!best || detection.confidence > best.detection.confidence)) best = { parser, detection };
  }
  if (!best) {
    throw new StatementError(
      "UNSUPPORTED_FORMAT",
      "Unsupported statement format. Supported: an HDFC Bank account statement PDF (from NetBanking) or a Google Pay transaction statement PDF (from the Google Pay app).",
    );
  }
  const statement = best.parser.parse(pages);
  if (statement.transactions.length === 0) {
    throw new StatementError("NO_TRANSACTIONS", "No transactions could be found in this statement.");
  }
  const normalized = best.parser.normalize ? best.parser.normalize(statement) : normalizeTransactions(statement.transactions);
  if (normalized.transactions.length === 0) {
    throw new StatementError("NO_TRANSACTIONS", "No valid transactions could be extracted from this statement.");
  }
  if (normalized.dropped.length) {
    statement.warnings.push(`${normalized.dropped.length} malformed row(s) were skipped (no amount).`);
  }
  return { statement, normalized, detection: best.detection, parserId: best.parser.id, pageCount: pages.length };
}
