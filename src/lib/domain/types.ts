import type { ISODate } from "../util/dates";

export type Direction = "debit" | "credit";

/**
 * Where a statement row came from. Every source is parsed by its own parser into the same canonical model; the rest of
 * the pipeline (normalisation, classification, matching, analytics, assistant) never cares which source it was.
 * Adding a source (PHONEPE, PAYTM, CSV...) = a parser + one entry here + a priority in matching/priority.
 */
export type TransactionSource = "HDFC" | "GOOGLE_PAY";

/** Output of a bank parser: raw values lifted off the page, minimally interpreted. */
export interface ParsedTransaction {
  /** Transaction date (DATE column). */
  date: ISODate;
  /** Value date (Value Dt column). May differ from `date`. */
  valueDate?: ISODate;
  /** Narration reconstructed into one string (wrapped lines re-joined). */
  rawDescription: string;
  /** Each physical narration line exactly as it appeared in the PDF (line breaks preserved). */
  narrationLines?: string[];
  /** Chq./Ref.No. column, verbatim (leading zeros kept). */
  reference?: string;
  debit: number;
  credit: number;
  /** The raw amount strings as extracted, before numeric parsing. */
  rawWithdrawal?: string;
  rawDeposit?: string;
  rawBalance?: string;
  balance?: number;
  rowIndex: number;
  page?: number;
  warnings: string[];
  /** Wallet / app statements (Google Pay): wall-clock time of the payment, "HH:MM" (24h). */
  time?: string;
  /** Counterparty exactly as printed ("Zepto Marketplace Pr"). */
  counterparty?: string;
  /** Provider's own transaction id (Google Pay: the UPI Transaction ID). */
  providerTxnId?: string;
  /** Bank the money moved from (debits) / into (credits), e.g. "HDFC Bank", and its last 4 digits. */
  fundingBank?: string;
  fundingMask?: string;
}

/** The bank's own STATEMENT SUMMARY block. */
export interface OfficialSummary {
  openingBalance: number;
  debitCount: number;
  creditCount: number;
  totalDebits: number;
  totalCredits: number;
  closingBalance: number;
}

export interface ReconCheck {
  key: string;
  label: string;
  /** null = could not be evaluated (e.g. no official summary). */
  ok: boolean | null;
  official?: number;
  calculated?: number;
}

export interface Reconciliation {
  /**
   * reconciled = the statement's own totals are reproduced exactly;
   * mismatch = they are not; requires_review = they are not, and something the statement does not describe (self
   * transfers, unrecognised rows) could explain it, so a person has to look. Never "reconciled" unless it is.
   */
  status: "reconciled" | "mismatch" | "no_summary" | "requires_review";
  official: OfficialSummary | null;
  /** Wallet-style statements (Google Pay) publish Sent / Received totals instead of a bank balance model. */
  providerTotals?: { sent: number; received: number; sentCalculated: number; receivedCalculated: number; excludedSelfTransfers: number };
  calculated: {
    debitCount: number;
    creditCount: number;
    totalDebits: number;
    totalCredits: number;
    /** Opening balance used for the maths (official if present, else derived from the first row). */
    openingBalance?: number;
    /** opening + credits − debits, from the parsed rows. */
    closingFromFlow?: number;
    /** Closing balance printed on the last parsed row. */
    lastRowBalance?: number;
  };
  checks: ReconCheck[];
  balanceChain: {
    checked: number;
    breaks: { rowIndex: number; date: string; expected: number; actual: number }[];
    /** Rows whose debit/credit side was corrected because the running balance proved the other side. */
    corrections: number;
  };
  issues: string[];
}

export interface ParsedStatement {
  bank: TransactionSource;
  parserVersion: string;
  account: { mask: string; type?: string };
  period?: { start: ISODate; end: ISODate };
  openingBalance?: number;
  closingBalance?: number;
  /** Totals printed by the bank in its "Statement Summary" (null when not found). */
  summary?: OfficialSummary;
  reconciliation?: Reconciliation;
  /** Provider-published totals (Google Pay: Sent / Received). */
  providerSummary?: { sent: number; received: number };
  transactions: ParsedTransaction[];
  warnings: string[];
}

export interface UpiDetails {
  merchantName?: string;
  upiId?: string;
  bankCode?: string;
  /** 12-digit UPI RRN found inside the narration (distinct from the Chq./Ref.No. column). */
  upiReference?: string;
  note?: string;
  isAutopay: boolean;
  /** UPI app / gateway / PSP inferred from the handle or narration. NOT a merchant. */
  paymentProvider?: string;
}

export interface NormalizedTransaction {
  txnDate: ISODate;
  valueDate?: ISODate;
  seq: number;
  /** Narration with the original line breaks preserved ("\n"-joined). */
  rawNarration: string;
  /** Re-joined narration as a single string (whitespace collapsed). Kept for compatibility. */
  rawDescription: string;
  description: string;
  /** Upper-case alphanumeric form used for matching / dedupe. */
  normalizedNarration: string;
  /** Chq./Ref.No. column value (verbatim). */
  referenceNumber?: string;
  upiReference?: string;
  upiId?: string;
  upiBankCode?: string;
  paymentProvider?: string;
  debit: number;
  credit: number;
  /** Magnitude, always >= 0. */
  amount: number;
  direction: Direction;
  transactionType: string;
  paymentMethod?: string;
  balanceAfter?: number;
  /** Party/merchant token pulled from the narration, before canonicalisation. */
  counterparty?: string;
  /** True when the counterparty token is a payment gateway/PSP rather than a merchant. */
  counterpartyIsGateway?: boolean;
  isAutopay: boolean;
  /** Narration contains refund / reversal wording. */
  refundHint: boolean;
  dedupeKey: string;
  warnings: string[];
  /** Source of this row. Undefined = HDFC (the original, only source). */
  source?: TransactionSource;
  /** "HH:MM" and the combined local date-time, when the source provides a time. */
  txnTime?: string;
  txnDateTime?: string;
  /** Counterparty exactly as the source printed it (kept even when the merchant is normalised). */
  counterpartyRaw?: string;
  /** Funding / receiving bank (never the merchant) and its last 4 digits. */
  fundingBank?: string;
  fundingMask?: string;
  /** SELF_TRANSFER | POSSIBLE_SELF_TRANSFER | PERSON_TO_PERSON | UNKNOWN_COUNTERPARTY | REFUND_REQUIRES_REVIEW */
  semanticType?: string;
}

export type ClassificationMethod = "user" | "rule" | "merchant" | "history" | "keyword" | "ai" | "recurring" | "none";

export interface Classification {
  merchant: string;
  merchantKey: string;
  /** 0-1: how sure we are that `merchant` is the real underlying business/person. */
  merchantConfidence: number;
  category: string;
  subcategory: string;
  confidence: number;
  method: ClassificationMethod;
  reason?: string;
}

export interface ClassifiedTransaction extends NormalizedTransaction, Classification {
  isDuplicate?: boolean;
  isRefund?: boolean;
  isRecurringCandidate?: boolean;
  recurringConfidence?: number;
  needsReview?: boolean;
  /** Cross-source evidence that this row is the same financial event as an already-imported row. */
  match?: TxnMatch;
}

/** A link between an incoming row and an existing row from another source. */
export interface TxnMatch {
  /** matched = same event (merged for analytics); potential = looks similar but needs a human decision. */
  status: "matched" | "potential";
  method: "upi_id" | "heuristic";
  confidence: number;
  reason: string;
  /** Human label of the row this points at, e.g. "HDFC · Blinkit · 2026-08-15 · ₹266". */
  existingLabel?: string;
  existingId: string;
  existingEventId: string;
  existingSource: TransactionSource;
  /** True when the existing row is currently the one analytics counts. */
  existingIsPrimary: boolean;
}

/** Lightweight row used by the analytics engine (no raw text). */
export interface TxnLite {
  id: string;
  /** Transaction date by default; the value date when the caller asks for value-date analysis. */
  date: ISODate;
  debit: number;
  credit: number;
  amount: number;
  direction: Direction;
  category: string;
  subcategory: string;
  merchant: string;
  description?: string;
  balanceAfter?: number | null;
  isRecurring?: boolean;
  confidence?: number;
  /** For refund credits: id of the original debit this refund reverses. */
  refundFor?: string | null;
  isRefund?: boolean;
  /** UPI, AUTOPAY, Debit Card, NEFT, ... (never the UPI id / reference). */
  paymentMethod?: string | null;
}

export type StatementErrorCode =
  | "INVALID_FILE"
  | "FILE_TOO_LARGE"
  | "INVALID_PDF"
  | "PASSWORD_REQUIRED"
  | "INCORRECT_PASSWORD"
  | "UNSUPPORTED_FORMAT"
  | "NO_TRANSACTIONS"
  | "PARSE_FAILED";

export class StatementError extends Error {
  constructor(
    public code: StatementErrorCode,
    message: string,
    public status = 422,
  ) {
    super(message);
    this.name = "StatementError";
  }
}
