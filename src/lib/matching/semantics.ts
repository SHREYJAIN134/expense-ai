/**
 * Self-transfer evidence. A payment to "yourself" is money moving between your own accounts, not spending and not
 * income. Google Pay leaves such payments out of its Sent / Received totals, so getting this right matters for
 * reconciliation - but guessing wrong would hide real spending. So:
 *
 *   SELF_TRANSFER           = proof: the counterparty is exactly the account holder's own name, or names one of
 *                             the user's own bank accounts (bank word + the account's last 4 digits);
 *   POSSIBLE_SELF_TRANSFER  = a hint only (the word "self", or a person-like name sharing a name part with the account
 *                             holder): the row is flagged for review and NEVER excluded automatically;
 *   undefined               = no evidence. Nothing is invented.
 */
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const BANK_WORD = /\b(BANK|A\/C|ACCOUNT|ACC|SAVINGS|HDFC|ICICI|SBI|AXIS|KOTAK|YES|PNB|CANARA|IDFC|FEDERAL)\b/;

export function detectSelfTransfer(counterparty: string | undefined, ownNames: string[], ownMasks: string[]): "SELF_TRANSFER" | "POSSIBLE_SELF_TRANSFER" | undefined {
  if (!counterparty) return undefined;
  const c = norm(counterparty);
  if (!c) return undefined;
  const names = ownNames.map(norm).filter((n) => n.length >= 4);
  if (names.some((n) => n === c)) return "SELF_TRANSFER";
  // "HDFC BANK 9332" naming one of the user's own accounts
  for (const mask of ownMasks) {
    if (mask.length >= 4 && new RegExp(`(^| )${mask}( |$)`).test(c) && BANK_WORD.test(c)) return "SELF_TRANSFER";
  }
  if (/(^| )SELF( |$)/.test(c)) return "POSSIBLE_SELF_TRANSFER";
  const own = new Set(names.flatMap((n) => n.split(" ")).filter((t) => t.length >= 4));
  if (own.size && c.split(" ").some((t) => own.has(t)) && /^[A-Z ]+$/.test(c)) return "POSSIBLE_SELF_TRANSFER";
  return undefined;
}
