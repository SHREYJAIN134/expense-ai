/**
 * Privacy filter for everything that may be sent to an external AI provider.
 *
 * The assistant sends the provider ONLY: the user's question, a small structured `facts` object and the
 * deterministic draft answer. This module guarantees that none of these carry:
 *   - account numbers, UPI ids (VPAs), UPI / bank reference numbers, IFSC-like bank codes;
 *   - transaction identifiers (ids, txnIds, refund links) and raw narrations / descriptions;
 *   - e-mail addresses, statement / PDF content, statement passwords.
 * Names of people the user transferred money to are replaced by neutral placeholders ("Person 1") and mapped back
 * only after the reply comes home, so the provider never sees them.
 *
 * It works by dropping sensitive KEYS and masking sensitive-looking VALUES, so a new field added to an answer later
 * cannot silently leak an identifier that follows the usual naming.
 */

/** Keys that are never sent. Case-sensitive on purpose (`paid` must not match `Id`). */
const SENSITIVE_KEY = /(^id$|Id$|Ids$|^upi|Upi|[rR]eference|^refs?$|^account|Account|refundFor|[nN]arration|^description$|^rawDescription$|^utr$|^rrn$|password|token|secret|apiKey|^email$|^pdf|IFSC|ifsc|[Ff]unding|counterpartyRaw)/;

const VPA = /[A-Za-z0-9._-]{2,}@[A-Za-z][A-Za-z0-9]{1,}/g; // name@bank
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const LONG_DIGITS = /\d{9,}/g; // account numbers, 12-digit UPI RRNs, 16-digit reference numbers
const BANK_CODE = /\b[A-Z]{4}0[A-Z0-9]{6}\b/g; // IFSC, e.g. HDFC0ABCDEF
const PDF_MARK = /%PDF-?/g;

export function maskSensitiveText(text: string): string {
  return text
    .replace(EMAIL, "[email]")
    .replace(VPA, "[upi id]")
    .replace(BANK_CODE, "[bank code]")
    .replace(LONG_DIGITS, "[number]")
    .replace(PDF_MARK, "");
}

/** Deep copy of `value` without sensitive keys and with sensitive-looking strings masked. */
export function sanitizeFacts<T>(value: T): T {
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return maskSensitiveText(v);
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        if (SENSITIVE_KEY.test(k)) continue;
        out[k] = walk(val);
      }
      return out;
    }
    return v;
  };
  return walk(value) as T;
}

/** Reversible replacement of personal names by placeholders. */
export class Redactor {
  private map = new Map<string, string>();
  private names: string[];

  constructor(names: string[]) {
    // longest first so "Rahul Negi Sr" is replaced before "Rahul Negi"
    this.names = [...new Set(names.map((n) => n.trim()).filter((n) => n.length >= 4))].sort((a, b) => b.length - a.length);
  }

  redact(text: string): string {
    let out = text;
    for (const name of this.names) {
      const re = new RegExp(`(^|[^A-Za-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9])`, "gi");
      out = out.replace(re, (_m, pre: string) => {
        let ph = this.map.get(name.toLowerCase());
        if (!ph) {
          ph = `Person ${this.map.size + 1}`;
          this.map.set(name.toLowerCase(), ph);
        }
        return `${pre}${ph}`;
      });
    }
    return out;
  }

  /** Put the real names back into text that came back from the provider. */
  restore(text: string): string {
    let out = text;
    const original = new Map<string, string>();
    for (const n of this.names) original.set(n.toLowerCase(), n);
    for (const [lower, ph] of this.map) out = out.split(ph).join(original.get(lower) ?? lower);
    return out;
  }

  get active() {
    return this.map.size > 0;
  }
}

export interface AiPayload {
  question: string;
  facts: string;
  draft: string;
}

/** Everything the narrator is allowed to see, already sanitised and with people redacted. */
export function buildAiPayload(question: string, facts: unknown, draft: string, redactor: Redactor): AiPayload {
  return {
    question: redactor.redact(maskSensitiveText(question)),
    facts: redactor.redact(JSON.stringify(sanitizeFacts(facts))),
    draft: redactor.redact(maskSensitiveText(draft)),
  };
}
