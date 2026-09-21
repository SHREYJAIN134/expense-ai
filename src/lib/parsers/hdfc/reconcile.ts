/**
 * Statement reconciliation. Independently recomputes counts/totals/closing balance from the
 * parsed rows and compares them with the bank's OWN "STATEMENT SUMMARY" (never substituting one
 * for the other), then walks the running-balance chain row by row.
 */
import { round2 } from "../../util/money";
import type { OfficialSummary, ParsedStatement, ReconCheck, Reconciliation } from "../../domain/types";

const TOL = 0.011;
const money = (n: number) => n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export function reconcileStatement(st: Pick<ParsedStatement, "transactions" | "summary" | "openingBalance" | "closingBalance">): Reconciliation {
  const rows = st.transactions;
  const official: OfficialSummary | null = st.summary ?? null;
  const debitRows = rows.filter((r) => r.debit > 0);
  const creditRows = rows.filter((r) => r.credit > 0);
  const totalDebits = round2(debitRows.reduce((a, r) => a + r.debit, 0));
  const totalCredits = round2(creditRows.reduce((a, r) => a + r.credit, 0));

  // Opening balance for the maths: official if we have it, otherwise derive from the first row's balance.
  let opening: number | undefined = official?.openingBalance ?? st.openingBalance;
  if (opening === undefined) {
    const first = rows.find((r) => r.balance !== undefined);
    if (first) opening = round2(first.balance! - first.credit + first.debit);
  }
  const closingFromFlow = opening === undefined ? undefined : round2(opening + totalCredits - totalDebits);
  const lastWithBalance = [...rows].reverse().find((r) => r.balance !== undefined);
  const lastRowBalance = lastWithBalance?.balance;

  const issues: string[] = [];
  const checks: ReconCheck[] = [];
  const cmp = (key: string, label: string, off: number | undefined, calc: number | undefined, isMoney: boolean) => {
    if (off === undefined || calc === undefined) {
      checks.push({ key, label, ok: null, official: off, calculated: calc });
      return;
    }
    const ok = isMoney ? Math.abs(off - calc) <= TOL : off === calc;
    checks.push({ key, label, ok, official: off, calculated: calc });
    if (!ok) issues.push(`${label}: statement says ${isMoney ? "₹" + money(off) : off}, parsed rows give ${isMoney ? "₹" + money(calc) : calc}.`);
  };

  if (official) {
    cmp("debitCount", "Debit count", official.debitCount, debitRows.length, false);
    cmp("creditCount", "Credit count", official.creditCount, creditRows.length, false);
    cmp("totalDebits", "Total debits", official.totalDebits, totalDebits, true);
    cmp("totalCredits", "Total credits", official.totalCredits, totalCredits, true);
    // The statement must be internally consistent: opening + credits - debits = closing.
    const officialFlow = round2(official.openingBalance + official.totalCredits - official.totalDebits);
    cmp("officialIdentity", "Opening + credits − debits = closing (as printed)", official.closingBalance, officialFlow, true);
    // ...and the parsed rows must reproduce the official closing balance.
    cmp("calculatedClosing", "Closing balance from parsed rows", official.closingBalance, closingFromFlow, true);
    cmp("lastRowBalance", "Closing balance on the last row", official.closingBalance, lastRowBalance, true);
  }

  // Running-balance chain: previous balance + credit − debit must equal this row's balance.
  const breaks: Reconciliation["balanceChain"]["breaks"] = [];
  let prev = opening;
  let checked = 0;
  for (const r of rows) {
    if (r.balance === undefined) continue;
    if (prev !== undefined) {
      checked++;
      const expected = round2(prev + r.credit - r.debit);
      if (Math.abs(expected - r.balance) > TOL) {
        breaks.push({ rowIndex: r.rowIndex, date: r.date, expected, actual: r.balance });
        if (!r.warnings.some((w) => /balance chain/i.test(w))) r.warnings.push("Running balance does not follow from the previous row (possible missing or mis-read row)");
      }
    }
    prev = r.balance;
  }
  if (breaks.length) {
    issues.push(`${breaks.length} row(s) break the running-balance chain (first at ${breaks[0].date}).`);
  }
  checks.push({ key: "balanceChain", label: "Running balance follows row by row", ok: checked === 0 ? null : breaks.length === 0 });

  const corrections = rows.filter((r) => r.warnings.some((w) => /side corrected/i.test(w))).length;
  if (corrections) issues.push(`${corrections} row(s) had their debit/credit side corrected from the running balance - review them.`);

  const failed = checks.some((c) => c.ok === false);
  const status: Reconciliation["status"] = failed || corrections > 0 ? "mismatch" : official ? "reconciled" : "no_summary";
  if (!official) issues.unshift("The statement summary block was not found, so totals could not be checked against the bank's own figures.");

  return {
    status,
    official,
    calculated: { debitCount: debitRows.length, creditCount: creditRows.length, totalDebits, totalCredits, openingBalance: opening, closingFromFlow, lastRowBalance },
    checks,
    balanceChain: { checked, breaks, corrections },
    issues,
  };
}
