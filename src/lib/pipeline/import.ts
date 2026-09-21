/**
 * Statement import pipeline.
 *
 *   upload -> decrypt -> parse -> reconstruct rows -> validate -> extract STATEMENT SUMMARY -> reconcile
 *          -> detect duplicates -> classify (rules/merchants/history/keywords/AI) -> PREVIEW (staged)
 *   confirm (with reconciliation acknowledgement when needed) -> atomic insert -> refund linking
 *          -> recurring refresh -> insights
 *
 * The PDF password lives only in `stageStatement`'s arguments and is passed straight to the PDF
 * reader. The original PDF bytes are never persisted. Nothing is written to `transactions` before
 * the user confirms the preview.
 */
import crypto from "node:crypto";
import { getDb, uid, withTransaction } from "../db/client";
import { StatementError, type ClassifiedTransaction, type OfficialSummary, type Reconciliation, type TransactionSource } from "../domain/types";
import { parseStatementPdf, type ParsedUpload } from "../parsers";
import { reconcileStatement } from "../parsers/hdfc/reconcile";
import { reconcileGooglePay } from "../parsers/googlepay/reconcile";
import { idKeys, matchAcrossSources, SOURCE_LABEL, type IncomingRow } from "../matching/cross-source";
import { detectSelfTransfer } from "../matching/semantics";
import { applyMatch, describeExisting, loadMatchCandidates, repairEvents, rrnTokens } from "../services/events";
import { classifyTransaction, type ClassifierContext } from "../classification/classifier";
import { merchantKeyOf } from "../classification/merchants";
import { refineWithAi } from "../classification/ai-classifier";
import { getAiProvider } from "../ai/provider";
import { round2 } from "../util/money";
import { bumpDataVersion } from "../services/data";
import { getSettings } from "../services/users";
import { refreshRecurringFlags, regenerateInsights } from "../services/planning";
import { linkRefunds } from "../services/refunds";
import { ApiError } from "../auth/guard";

export type Stage = "decrypt" | "parse" | "validate" | "reconcile" | "duplicates" | "classify" | "preview" | "import" | "analytics" | "done";
export type ProgressFn = (stage: Stage, detail?: string) => void;

export interface OverlapInfo {
  /** Already imported statements whose period overlaps this one. */
  statements: { id: string; filename: string; source: string; periodStart: string; periodEnd: string }[];
  /** Counted transactions (any source) that already exist inside this statement's period. */
  existingInPeriod: number;
}

export interface StagedStatement {
  bank: string;
  source?: TransactionSource;
  providerSummary?: { sent: number; received: number };
  overlap?: OverlapInfo;
  account: { mask: string; type?: string };
  period?: { start: string; end: string };
  openingBalance?: number;
  closingBalance?: number;
  summary?: OfficialSummary;
  reconciliation: Reconciliation;
  warnings: string[];
  aiNote?: string;
  transactions: ClassifiedTransaction[];
}

export interface PreviewRow {
  seq: number;
  date: string;
  valueDate?: string;
  description: string;
  narrationLines: string[];
  reference?: string;
  merchant: string;
  merchantConfidence: number;
  category: string;
  subcategory: string;
  confidence: number;
  method: string;
  paymentMethod?: string;
  paymentProvider?: string;
  debit: number;
  credit: number;
  balance?: number;
  type: string;
  isDuplicate: boolean;
  isRefund: boolean;
  isRecurringCandidate: boolean;
  needsReview: boolean;
  warnings: string[];
  source: TransactionSource;
  time?: string;
  semanticType?: string;
  match?: { status: "matched" | "potential"; method: string; confidence: number; reason: string; with: string };
}

export interface PreviewResult {
  statementId: string;
  filename: string;
  bank: string;
  source: TransactionSource;
  sourceLabel: string;
  account: { mask: string; type?: string };
  period?: { start: string; end: string };
  counts: {
    total: number;
    new: number;
    duplicates: number;
    debits: number;
    credits: number;
    refunds: number;
    autopay: number;
    recurringCandidates: number;
    unclassified: number;
    needsReview: number;
    lowConfidence: number;
    /** Rows that are the same financial event as a row already imported from another source (proven by UPI id). */
    matched: number;
    /** Rows that look like an existing row from another source but need a person to decide. */
    potential: number;
    /** Rows that add a genuinely new financial event to your history. */
    newEvents: number;
  };
  /** Confidence distribution of the NEW transactions. */
  confidence: { high: number; medium: number; low: number };
  totals: { debits: number; credits: number; newDebits: number; newCredits: number; newEventDebits: number; newEventCredits: number };
  /** Google Pay style statements: the provider's own Sent / Received totals vs the parsed rows. */
  providerTotals?: { sent: number; received: number; sentCalculated: number; receivedCalculated: number; excludedSelfTransfers: number };
  overlap: OverlapInfo;
  openingBalance?: number;
  closingBalance?: number;
  /** Closing balance recomputed from the parsed rows (opening + credits − debits). */
  calculatedClosingBalance?: number;
  reconciliation: Reconciliation;
  /** True when reconciliation failed: the user must explicitly acknowledge before importing. */
  requiresAcknowledgement: boolean;
  warnings: string[];
  duplicateStatement: boolean;
  transactions: PreviewRow[];
  truncated: boolean;
}

const PREVIEW_ROW_CAP = 1500;
const STALE_PREVIEW_HOURS = 24;

/* ------------------------- classifier context from DB ------------------------- */

export function buildClassifierContext(userId: string): ClassifierContext {
  const db = getDb();
  const ctx: ClassifierContext = { overrides: new Map(), history: new Map() };
  for (const r of db
    .prepare("SELECT merchant_key, merchant_name, category, subcategory FROM merchant_overrides WHERE user_id = ?")
    .all(userId) as { merchant_key: string; merchant_name: string | null; category: string | null; subcategory: string | null }[]) {
    ctx.overrides.set(r.merchant_key, { name: r.merchant_name, category: r.category, subcategory: r.subcategory });
  }
  const hist = db
    .prepare(
      `SELECT merchant, category, subcategory, COUNT(*) AS n, AVG(classification_confidence) AS conf
       FROM transactions WHERE user_id = ? AND is_primary = 1 AND merchant IS NOT NULL AND category NOT IN ('OTHER','NEEDS_REVIEW') AND classification_source != 'none'
       GROUP BY merchant, category, subcategory`,
    )
    .all(userId) as { merchant: string; category: string; subcategory: string; n: number; conf: number }[];
  for (const h of hist) {
    const key = merchantKeyOf(h.merchant);
    const cur = ctx.history.get(key);
    if (!cur || h.n > cur.count) ctx.history.set(key, { category: h.category, subcategory: h.subcategory, count: h.n, confidence: h.conf });
  }
  return ctx;
}

/* ---------------------------------- flags ---------------------------------- */

/**
 * Derived review/refund/recurrence flags. Deliberately conservative: an AUTOPAY debit is only a
 * recurring CANDIDATE (weak evidence) until history confirms a pattern.
 */
export function finalizeFlags(t: ClassifiedTransaction, priorSameMerchant = 0): ClassifiedTransaction {
  t.isRefund = t.direction === "credit" && t.category === "REFUNDS";
  const historyEvidence = t.direction === "debit" && priorSameMerchant >= 2;
  t.isRecurringCandidate = t.direction === "debit" && (t.isAutopay || historyEvidence);
  t.recurringConfidence = !t.isRecurringCandidate ? 0 : t.isAutopay && historyEvidence ? 0.75 : t.isAutopay ? 0.4 : 0.5;
  // People and unknown one-word counterparties may be a friend, a shared bill or a tiny shop: a person should look.
  const semanticReview = t.semanticType === "PERSON_TO_PERSON" || t.semanticType === "UNKNOWN_COUNTERPARTY" || t.semanticType === "POSSIBLE_SELF_TRANSFER";
  t.needsReview = t.category === "NEEDS_REVIEW" || t.confidence < 0.6 || t.merchantConfidence < 0.4 || t.warnings.length > 0 || semanticReview;
  return t;
}

/* ---------------------------------- staging ---------------------------------- */

export async function stageStatement(
  userId: string,
  file: { name: string; data: Uint8Array },
  password: string | undefined,
  onProgress: ProgressFn = () => undefined,
): Promise<PreviewResult> {
  const sha = crypto.createHash("sha256").update(file.data).digest("hex");

  onProgress("decrypt", password ? "Decrypting PDF" : "Opening PDF");
  // NOTE: `password` is only forwarded to the PDF reader; it is never stored or logged.
  const parsed = await parseStatementPdf(file.data, password);
  onProgress("parse", `Reconstructed ${parsed.normalized.transactions.length} transactions from ${parsed.pageCount} page(s)`);
  return stageParsed(userId, { name: file.name, size: file.data.byteLength, sha }, parsed, onProgress);
}

/** Everything after PDF parsing: reconcile, dedupe, classify and persist a preview. Shared with the demo seeder. */
export async function stageParsed(
  userId: string,
  file: { name: string; size: number; sha: string },
  parsed: Pick<ParsedUpload, "statement" | "normalized">,
  onProgress: ProgressFn = () => undefined,
): Promise<PreviewResult> {
  const db = getDb();
  const sha = file.sha;
  const { statement, normalized } = parsed;

  onProgress("validate", "Validating structure and running balances");
  onProgress("reconcile", "Reconciling with the statement summary");
  const reconciliation = statement.reconciliation ?? reconcileStatement(statement);

  onProgress("duplicates", "Checking for transactions you already imported");
  const keys = normalized.transactions.map((t) => t.dedupeKey);
  const existing = new Set<string>();
  for (let i = 0; i < keys.length; i += 500) {
    const chunk = keys.slice(i, i + 500);
    const rows = db
      .prepare(`SELECT dedupe_key FROM transactions WHERE user_id = ? AND dedupe_key IN (${chunk.map(() => "?").join(",")})`)
      .all(userId, ...chunk) as { dedupe_key: string }[];
    for (const r of rows) existing.add(r.dedupe_key);
  }
  // Second line of evidence: the Chq./Ref.No. is transaction-specific. Same reference + direction + amount + date
  // is the same transaction even if the narration was re-wrapped differently between two PDFs.
  const refKeys = new Set<string>();
  const refs = [...new Set(normalized.transactions.map((t) => t.referenceNumber).filter((r): r is string => !!r))];
  for (let i = 0; i < refs.length; i += 500) {
    const chunk = refs.slice(i, i + 500);
    const rows = db
      .prepare(`SELECT reference_number, direction, amount, txn_date FROM transactions WHERE user_id = ? AND reference_number IN (${chunk.map(() => "?").join(",")})`)
      .all(userId, ...chunk) as { reference_number: string; direction: string; amount: number; txn_date: string }[];
    for (const r of rows) refKeys.add(`${r.reference_number}|${r.direction}|${r.amount.toFixed(2)}|${r.txn_date}`);
  }
  const alreadyImported = db
    .prepare("SELECT id, imported_at FROM statements WHERE user_id = ? AND file_sha256 = ? AND status = 'imported' LIMIT 1")
    .get(userId, sha) as { id: string; imported_at: string } | undefined;

  onProgress("classify", "Classifying transactions");
  const ctx = buildClassifierContext(userId);
  const merchantHistory = new Map<string, number>();
  for (const r of db
    .prepare("SELECT merchant, COUNT(*) AS n FROM transactions WHERE user_id = ? AND is_primary = 1 AND direction = 'debit' AND merchant IS NOT NULL GROUP BY merchant")
    .all(userId) as { merchant: string; n: number }[]) merchantHistory.set(merchantKeyOf(r.merchant), r.n);

  const classified: ClassifiedTransaction[] = normalized.transactions.map((t) => ({
    ...t,
    ...classifyTransaction(t, ctx),
    isDuplicate:
      existing.has(t.dedupeKey) ||
      (!!t.referenceNumber && refKeys.has(`${t.referenceNumber}|${t.direction}|${t.amount.toFixed(2)}|${t.txnDate}`)),
  }));

  // AI only for genuinely ambiguous, NEW rows, and only if enabled + configured.
  let aiNote: string | undefined;
  const settings = getSettings(userId);
  const provider = settings.aiClassification ? getAiProvider() : null;
  if (provider) {
    const res = await refineWithAi(classified.filter((c) => !c.isDuplicate), provider);
    if (res.failed) aiNote = "AI classification was unavailable; ambiguous transactions were left as OTHER / Unclassified.";
    else if (res.applied) aiNote = `AI suggested categories for ${res.applied} ambiguous transaction(s). Review them below.`;
  }
  const source: TransactionSource = statement.bank;
  // Self transfers: only with evidence (the user's own name / own account digits). Never guessed.
  if (source === "GOOGLE_PAY") {
    const own = ownIdentity(userId);
    for (const c of classified) {
      const self = detectSelfTransfer(c.counterpartyRaw ?? c.counterparty, own.names, own.masks);
      if (self === "SELF_TRANSFER") {
        c.semanticType = "SELF_TRANSFER";
        c.category = "TRANSFERS";
        c.subcategory = "Self Transfer";
        c.confidence = 0.95;
        c.method = "rule";
        c.reason = "The counterparty is one of your own accounts";
      } else if (self === "POSSIBLE_SELF_TRANSFER") c.semanticType = "POSSIBLE_SELF_TRANSFER";
    }
  }
  for (const c of classified) finalizeFlags(c, merchantHistory.get(c.merchantKey) ?? 0);

  // Wallet-style statements reconcile Sent / Received (self transfers are excluded by the provider), not a balance.
  const finalReconciliation =
    source === "GOOGLE_PAY"
      ? reconcileGooglePay(statement.providerSummary, classified.map((c) => ({ direction: c.direction, amount: c.amount, semanticType: c.semanticType })))
      : reconciliation;

  // Cross-source matching: is any row the same real-world event as a row already imported from another source?
  const dates = classified.map((c) => c.txnDate).sort();
  const candidates = dates.length ? loadMatchCandidates(userId, source, dates[0], dates[dates.length - 1]) : [];
  const incoming: IncomingRow[] = [];
  classified.forEach((c, index) => {
    if (c.isDuplicate) return;
    incoming.push({
      index,
      source,
      direction: c.direction,
      amount: c.amount,
      date: c.txnDate,
      ids: [...new Set([...idKeys(c.upiReference, c.referenceNumber), ...rrnTokens(c.normalizedNarration)])],
      merchantKey: merchantKeyOf(c.merchant),
    });
  });
  for (const [index, m] of matchAcrossSources(incoming, candidates)) {
    classified[index].match = { ...m, existingLabel: describeExisting(db, userId, m.existingId) };
  }
  const overlap = findOverlap(userId, statement.period);

  const warnings = [...statement.warnings];
  if (overlap.statements.length && !alreadyImported) {
    const first = overlap.statements[0];
    warnings.unshift(
      `This statement overlaps with ${overlap.statements.length === 1 ? "an existing statement" : `${overlap.statements.length} existing statements`} (${SOURCE_LABEL[first.source as TransactionSource] ?? first.source}, ${first.periodStart} to ${first.periodEnd}). ` +
        "Rows that are provably the same payment are matched instead of counted twice; check the matched and potential counts below.",
    );
  }
  if (alreadyImported) warnings.unshift("This exact file was already imported. Nothing new will be added.");
  const dupCount = classified.filter((c) => c.isDuplicate).length;
  if (dupCount > 0 && !alreadyImported) warnings.unshift(`${dupCount} transaction(s) already exist in your history and will be skipped.`);

  const staged: StagedStatement = {
    bank: statement.bank,
    source,
    providerSummary: statement.providerSummary,
    overlap,
    account: statement.account,
    period: statement.period,
    openingBalance: statement.openingBalance,
    closingBalance: statement.closingBalance,
    summary: statement.summary,
    reconciliation: finalReconciliation,
    warnings,
    aiNote,
    transactions: classified,
  };

  // Drop earlier abandoned previews, then persist this one.
  db.prepare("DELETE FROM statements WHERE user_id = ? AND status IN ('preview','failed') AND created_at < datetime('now', ?)").run(userId, `-${STALE_PREVIEW_HOURS} hours`);
  const statementId = uid();
  const fresh = classified.filter((c) => !c.isDuplicate);
  const off = finalReconciliation.official;
  const prov = finalReconciliation.providerTotals;
  db.prepare(
    `INSERT INTO statements (id, user_id, bank, filename, file_size, file_sha256, period_start, period_end, status, txn_count,
       duplicates_skipped, total_debits, total_credits, opening_balance, closing_balance, warnings_json, staged_json,
       official_debit_count, official_credit_count, official_total_debits, official_total_credits,
       calculated_closing_balance, reconciliation_status, reconciliation_json, provider_summary_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'preview', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    statementId, userId, statement.bank, sanitizeFilename(file.name), file.size, sha,
    statement.period?.start ?? null, statement.period?.end ?? null,
    fresh.length, dupCount,
    round2(classified.reduce((a, c) => a + c.debit, 0)), round2(classified.reduce((a, c) => a + c.credit, 0)),
    statement.openingBalance ?? null, statement.closingBalance ?? null,
    JSON.stringify(warnings), JSON.stringify(staged),
    off?.debitCount ?? null, off?.creditCount ?? null, off?.totalDebits ?? prov?.sent ?? null, off?.totalCredits ?? prov?.received ?? null,
    finalReconciliation.calculated.closingFromFlow ?? null, finalReconciliation.status, JSON.stringify(finalReconciliation),
    statement.providerSummary ? JSON.stringify(statement.providerSummary) : null,
  );
  onProgress("preview", "Preview ready");
  return buildPreview(statementId, sanitizeFilename(file.name), staged, !!alreadyImported);
}

/** The user's own name and account digits: the only evidence used to recognise transfers between their own accounts. */
function ownIdentity(userId: string): { names: string[]; masks: string[] } {
  const db = getDb();
  const u = db.prepare("SELECT name FROM users WHERE id = ?").get(userId) as { name: string } | undefined;
  const masks = (db.prepare("SELECT DISTINCT account_mask FROM accounts WHERE user_id = ? AND account_mask != 'UNKNOWN'").all(userId) as { account_mask: string }[]).map((r) => r.account_mask);
  return { names: u?.name ? [u.name] : [], masks };
}

function findOverlap(userId: string, period?: { start: string; end: string }): OverlapInfo {
  if (!period) return { statements: [], existingInPeriod: 0 };
  const db = getDb();
  const statements = (
    db
      .prepare(
        `SELECT id, filename, bank, period_start, period_end FROM statements
         WHERE user_id = ? AND status = 'imported' AND period_start IS NOT NULL AND period_end IS NOT NULL AND period_start <= ? AND period_end >= ?
         ORDER BY period_start`,
      )
      .all(userId, period.end, period.start) as any[]
  ).map((r) => ({ id: r.id as string, filename: r.filename as string, source: r.bank as string, periodStart: r.period_start as string, periodEnd: r.period_end as string }));
  const n = (db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND is_primary = 1 AND txn_date BETWEEN ? AND ?").get(userId, period.start, period.end) as { n: number }).n;
  return { statements, existingInPeriod: n };
}

export function sanitizeFilename(name: string): string {
  return name.replace(/[^\w.\- ()]/g, "_").slice(0, 120) || "statement.pdf";
}

function buildPreview(statementId: string, filename: string, staged: StagedStatement, duplicateStatement: boolean): PreviewResult {
  const all = staged.transactions;
  const fresh = all.filter((t) => !t.isDuplicate);
  const rows = all.slice(0, PREVIEW_ROW_CAP).map<PreviewRow>((t) => ({
    seq: t.seq,
    date: t.txnDate,
    valueDate: t.valueDate,
    description: t.description,
    narrationLines: t.rawNarration.split("\n"),
    reference: t.referenceNumber,
    merchant: t.merchant,
    merchantConfidence: t.merchantConfidence,
    category: t.category,
    subcategory: t.subcategory,
    confidence: t.confidence,
    method: t.method,
    paymentMethod: t.paymentMethod,
    paymentProvider: t.paymentProvider,
    debit: t.debit,
    credit: t.credit,
    balance: t.balanceAfter,
    type: t.transactionType,
    isDuplicate: !!t.isDuplicate,
    isRefund: !!t.isRefund,
    isRecurringCandidate: !!t.isRecurringCandidate,
    needsReview: !!t.needsReview,
    warnings: t.warnings,
    source: t.source ?? "HDFC",
    time: t.txnTime,
    semanticType: t.semanticType,
    match: t.match ? { status: t.match.status, method: t.match.method, confidence: t.match.confidence, reason: t.match.reason, with: t.match.existingLabel ?? "an earlier row" } : undefined,
  }));
  const rec = staged.reconciliation;
  const source: TransactionSource = staged.source ?? "HDFC";
  const matchedRows = fresh.filter((t) => t.match?.status === "matched");
  const potentialRows = fresh.filter((t) => t.match?.status === "potential");
  const newEventRows = fresh.filter((t) => t.match?.status !== "matched");
  return {
    statementId,
    filename,
    bank: staged.bank,
    source,
    sourceLabel: SOURCE_LABEL[source] ?? source,
    account: staged.account,
    period: staged.period,
    counts: {
      total: all.length,
      new: fresh.length,
      duplicates: all.length - fresh.length,
      debits: all.filter((t) => t.direction === "debit").length,
      credits: all.filter((t) => t.direction === "credit").length,
      refunds: all.filter((t) => t.isRefund).length,
      autopay: all.filter((t) => t.isAutopay).length,
      recurringCandidates: all.filter((t) => t.isRecurringCandidate).length,
      unclassified: fresh.filter((t) => t.category === "OTHER" || t.category === "NEEDS_REVIEW").length,
      needsReview: fresh.filter((t) => t.needsReview).length,
      lowConfidence: fresh.filter((t) => t.confidence < 0.6).length,
      matched: matchedRows.length,
      potential: potentialRows.length,
      newEvents: newEventRows.length,
    },
    confidence: {
      high: fresh.filter((t) => t.confidence >= 0.85).length,
      medium: fresh.filter((t) => t.confidence >= 0.6 && t.confidence < 0.85).length,
      low: fresh.filter((t) => t.confidence < 0.6).length,
    },
    totals: {
      debits: round2(all.reduce((a, t) => a + t.debit, 0)),
      credits: round2(all.reduce((a, t) => a + t.credit, 0)),
      newDebits: round2(fresh.reduce((a, t) => a + t.debit, 0)),
      newCredits: round2(fresh.reduce((a, t) => a + t.credit, 0)),
      newEventDebits: round2(newEventRows.reduce((a, t) => a + t.debit, 0)),
      newEventCredits: round2(newEventRows.reduce((a, t) => a + t.credit, 0)),
    },
    providerTotals: rec.providerTotals,
    overlap: staged.overlap ?? { statements: [], existingInPeriod: 0 },
    openingBalance: staged.openingBalance,
    closingBalance: staged.closingBalance,
    calculatedClosingBalance: rec.calculated.closingFromFlow,
    reconciliation: rec,
    requiresAcknowledgement: rec.status === "mismatch" || rec.status === "requires_review",
    warnings: [...staged.warnings, ...(staged.aiNote ? [staged.aiNote] : [])],
    duplicateStatement,
    transactions: rows,
    truncated: all.length > PREVIEW_ROW_CAP,
  };
}

export function getPreview(userId: string, statementId: string): PreviewResult {
  const row = getDb().prepare("SELECT id, filename, status, staged_json, file_sha256 FROM statements WHERE id = ? AND user_id = ?").get(statementId, userId) as
    | { id: string; filename: string; status: string; staged_json: string | null; file_sha256: string }
    | undefined;
  if (!row || row.status !== "preview" || !row.staged_json) throw new ApiError(404, "NOT_FOUND", "No pending import found. Upload the statement again.");
  const dup = !!getDb().prepare("SELECT 1 FROM statements WHERE user_id = ? AND file_sha256 = ? AND status = 'imported'").get(userId, row.file_sha256);
  return buildPreview(row.id, row.filename, JSON.parse(row.staged_json) as StagedStatement, dup);
}

/* ---------------------------------- confirm ---------------------------------- */

export interface ImportResult {
  statementId: string;
  imported: number;
  /** Rows saved as corroborating copies of events already counted from another source (never double counted). */
  mergedWithOtherSource: number;
  duplicatesSkipped: number;
  accountId: string;
  refundsLinked: number;
  recurring: { series: number; flagged: number; promoted: number };
}

export interface ConfirmOptions {
  onProgress?: ProgressFn;
  /** Required when the preview's reconciliation status is "mismatch". */
  acknowledgeReconciliation?: boolean;
}

export function confirmImport(userId: string, statementId: string, opts: ConfirmOptions | ProgressFn = {}): ImportResult {
  const options: ConfirmOptions = typeof opts === "function" ? { onProgress: opts } : opts;
  const onProgress = options.onProgress ?? (() => undefined);
  const db = getDb();
  const st = db.prepare("SELECT id, status, staged_json, filename FROM statements WHERE id = ? AND user_id = ?").get(statementId, userId) as
    | { id: string; status: string; staged_json: string | null; filename: string }
    | undefined;
  if (!st) throw new ApiError(404, "NOT_FOUND", "Statement not found.");
  if (st.status === "imported") throw new ApiError(409, "ALREADY_IMPORTED", "This statement was already imported.");
  if (st.status !== "preview" || !st.staged_json) throw new ApiError(409, "NOT_STAGED", "This statement is not awaiting confirmation.");
  const staged = JSON.parse(st.staged_json) as StagedStatement;

  if ((staged.reconciliation?.status === "mismatch" || staged.reconciliation?.status === "requires_review") && !options.acknowledgeReconciliation) {
    throw new ApiError(409, "RECONCILIATION_FAILED", staged.reconciliation.status === "requires_review" ? "This statement only reconciles if some transactions are transfers between your own accounts. Review them and confirm explicitly to import." : "This statement does not reconcile with its own summary. Review the differences and confirm explicitly to import anyway.", {
      issues: staged.reconciliation.issues,
    });
  }

  onProgress("import", "Saving transactions");
  let result: Omit<ImportResult, "recurring" | "refundsLinked">;
  try {
    // All-or-nothing: any failure rolls back every row of this import.
    result = withTransaction((tx) => {
      const acct = tx
        .prepare("SELECT id FROM accounts WHERE user_id = ? AND bank = ? AND account_mask = ?")
        .get(userId, staged.bank, staged.account.mask) as { id: string } | undefined;
      const accountId = acct?.id ?? uid();
      if (!acct) {
        tx.prepare("INSERT INTO accounts (id, user_id, bank, account_mask, account_type) VALUES (?, ?, ?, ?, ?)").run(
          accountId, userId, staged.bank, staged.account.mask, staged.account.type ?? null,
        );
      }
      const insTxn = tx.prepare(
        `INSERT INTO transactions (id, user_id, account_id, statement_id, txn_date, value_date, seq, raw_description, description,
           reference_number, debit, credit, amount, direction, transaction_type, balance_after, merchant, category, subcategory,
           classification_confidence, classification_source, payment_method, dedupe_key,
           raw_narration, normalized_narration, upi_id, upi_bank_code, upi_reference, payment_provider, merchant_confidence,
           is_refund, is_recurring_candidate, recurring_confidence, needs_review,
           source, event_id, is_primary, txn_time, txn_datetime, counterparty_raw, funding_bank, funding_mask, semantic_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (user_id, dedupe_key) DO NOTHING`, // only true duplicates are skipped; constraint violations abort the import
      );
      const insCls = tx.prepare(
        "INSERT INTO transaction_classifications (id, transaction_id, user_id, merchant, category, subcategory, confidence, method, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      );
      let imported = 0;
      let merged = 0;
      let latest: { date: string; seq: number; balance: number } | null = null;
      for (const t of staged.transactions) {
        if (t.isDuplicate) continue; // already identified as existing (key or reference evidence)
        const id = uid();
        const r = insTxn.run(
          id, userId, accountId, statementId, t.txnDate, t.valueDate ?? null, t.seq, t.rawDescription, t.description,
          t.referenceNumber ?? null, t.debit, t.credit, t.amount, t.direction, t.transactionType, t.balanceAfter ?? null,
          t.merchant, t.category, t.subcategory, t.confidence, t.method, t.paymentMethod ?? null, t.dedupeKey,
          t.rawNarration, t.normalizedNarration, t.upiId ?? null, t.upiBankCode ?? null, t.upiReference ?? null, t.paymentProvider ?? null, t.merchantConfidence,
          t.isRefund ? 1 : 0, t.isRecurringCandidate ? 1 : 0, t.recurringConfidence ?? 0, t.needsReview ? 1 : 0,
          staged.source ?? "HDFC", id, t.txnTime ?? null, t.txnDateTime ?? null, t.counterpartyRaw ?? null, t.fundingBank ?? null, t.fundingMask ?? null, t.semanticType ?? null,
        );
        if (r.changes === 1) {
          imported++;
          // Same real-world event as a row from another source? Link them (the bank row is the one analytics counts).
          if (t.match) {
            const linked = applyMatch(tx, userId, id, staged.source ?? "HDFC", t.match);
            if (linked?.merged) merged++;
          }
          insCls.run(uid(), id, userId, t.merchant, t.category, t.subcategory, t.confidence, t.method, t.reason ?? null);
          if (t.balanceAfter !== undefined && (!latest || t.txnDate > latest.date || (t.txnDate === latest.date && t.seq >= latest.seq))) {
            latest = { date: t.txnDate, seq: t.seq, balance: t.balanceAfter };
          }
        }
      }
      if (latest) {
        tx.prepare(
          "UPDATE accounts SET latest_balance = ?, balance_as_of = ? WHERE id = ? AND (balance_as_of IS NULL OR balance_as_of <= ?)",
        ).run(latest.balance, latest.date, accountId, latest.date);
      }
      const skipped = staged.transactions.length - imported;
      // A re-upload where every row already exists adds nothing, so it is not kept as a history entry.
      tx.prepare(
        `UPDATE statements SET status = ?, account_id = ?, txn_count = ?, duplicates_skipped = ?, staged_json = NULL,
           imported_at = datetime('now'), error_message = NULL WHERE id = ?`,
      ).run(imported > 0 ? "imported" : "discarded", accountId, imported, skipped, statementId);
      return { statementId, imported, duplicatesSkipped: skipped, accountId, mergedWithOtherSource: merged };
    });
  } catch {
    db.prepare("UPDATE statements SET status = 'failed', error_message = ? WHERE id = ?").run("Import failed and was rolled back.", statementId);
    throw new StatementError("PARSE_FAILED", "Import failed and was rolled back; no partial data was saved.", 500);
  }

  bumpDataVersion(userId);
  onProgress("analytics", "Linking refunds and updating analytics");
  const refundsLinked = linkRefunds(userId).linked;
  const recurring = refreshRecurringFlags(userId);
  regenerateInsights(userId);
  onProgress("done");
  return { ...result, refundsLinked, recurring };
}

export function discardStatement(userId: string, statementId: string) {
  const r = getDb().prepare("UPDATE statements SET status = 'discarded', staged_json = NULL WHERE id = ? AND user_id = ? AND status = 'preview'").run(statementId, userId);
  if (r.changes === 0) throw new ApiError(404, "NOT_FOUND", "No pending import found.");
  return { ok: true };
}

/** Delete an imported statement and every transaction that came from it. */
export function deleteStatement(userId: string, statementId: string) {
  const db = getDb();
  const r = withTransaction(() => {
    db.prepare("DELETE FROM transactions WHERE statement_id = ? AND user_id = ?").run(statementId, userId);
    return db.prepare("DELETE FROM statements WHERE id = ? AND user_id = ?").run(statementId, userId);
  });
  if (r.changes === 0) throw new ApiError(404, "NOT_FOUND", "Statement not found.");
  repairEvents(userId); // a Google Pay row that was only a copy of a deleted HDFC row becomes the counted one
  bumpDataVersion(userId);
  linkRefunds(userId);
  refreshRecurringFlags(userId);
  regenerateInsights(userId);
  return { ok: true };
}

export function listStatements(userId: string) {
  return (
    getDb()
      .prepare(
        `SELECT s.id, s.filename, s.bank, s.period_start, s.period_end, s.status, s.txn_count, s.duplicates_skipped,
                s.total_debits, s.total_credits, s.opening_balance, s.closing_balance, s.created_at, s.imported_at, s.is_demo,
                s.reconciliation_status, s.official_debit_count, s.official_credit_count, a.account_mask
         FROM statements s LEFT JOIN accounts a ON a.id = s.account_id
         WHERE s.user_id = ? AND s.status IN ('imported','preview','failed')
         ORDER BY COALESCE(s.period_end, s.created_at) DESC, s.created_at DESC`,
      )
      .all(userId) as any[]
  ).map((r) => ({
    id: r.id as string,
    filename: r.filename as string,
    bank: r.bank as string,
    accountMask: r.account_mask as string | null,
    periodStart: r.period_start as string | null,
    periodEnd: r.period_end as string | null,
    status: r.status as string,
    transactionCount: r.txn_count as number,
    duplicatesSkipped: r.duplicates_skipped as number,
    totalDebits: r.total_debits as number,
    totalCredits: r.total_credits as number,
    openingBalance: r.opening_balance as number | null,
    closingBalance: r.closing_balance as number | null,
    reconciliationStatus: r.reconciliation_status as string | null,
    officialDebitCount: r.official_debit_count as number | null,
    officialCreditCount: r.official_credit_count as number | null,
    uploadedAt: r.created_at as string,
    importedAt: r.imported_at as string | null,
    isDemo: !!r.is_demo,
    source: r.bank as string,
  }));
}
