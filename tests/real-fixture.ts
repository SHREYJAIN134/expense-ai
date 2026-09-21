/**
 * SYNTHETIC fixture reproducing the STRUCTURE of a real HDFC statement, sized to the reconciliation
 * figures in the spec:
 *   opening 29,004.97 · 76 debits = 12,379.76 · 8 credits = 5,868.00 · closing 22,493.21
 * All arithmetic is in integer paise so the totals are exact. No real data.
 *
 * Special rows (all deliberately present):
 *   - the ₹625.00 first row from the spec example (→ balance 28,379.97), Rahul Negi-style person UPI
 *   - Blinkit ₹266.00 debit immediately followed by a ₹266.00 refund credit (must NOT be a duplicate)
 *   - AUTOPAY: Google Play, Spotify India Pvt Ltd
 *   - a row whose value date differs from its transaction date (25/08/26 → 26/08/26)
 *   - identical debit amounts on the same day, and two identical credits on the same day
 *   - a gateway-only merchant (Razorpay) that must NOT become a merchant
 *   - merchants: Blinkit, Zepto, Swiggy, Juice Cafe, Big Save, Google India, Spotify, Rapido, Unstop
 */
import type { OfficialFigures, RealRow } from "../scripts/real-pdf";

const p2r = (paise: number) => paise / 100;
const rrn = (n: number) => String(620000000000 + n * 7919).padStart(12, "0").slice(0, 12);
const REF = (r: string) => "0000" + r;

interface Spec {
  day: number;
  narration: string;
  debit?: number; // paise
  credit?: number; // paise
  valueDay?: number;
  ref?: string;
}

const HAND_DEBITS = 9; // number of hand-written debits below (see the list)

function handRows(): Spec[] {
  return [
    // 1. the spec example: 625.00 debit on 01/08/26 -> balance 28,379.97
    { day: 1, narration: `UPI-RAHUL NEGI-RAKHINEGI634@OKHDFCBANK-PUNB0123456-${rrn(1)}-UPI`, debit: 62500, ref: REF("621331236828") },
    // 2-3. Blinkit debit then refund (same amount, same merchant, same day)
    { day: 3, narration: "UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0MERUPI-622758185216-PAY VIA RAZORPAY", debit: 26600, ref: REF("622758185216") },
    { day: 3, narration: "UPI-BLINKIT-BLINKIT.RZP@HDFCBANK-HDFC0MERUPI-622758185299-REFUND", credit: 26600, ref: REF("622758185299") },
    // 4-5. AUTOPAY mandates
    { day: 5, narration: `UPI-AUTOPAY-GOOGLE PLAY-GOOGLEPLAY@OKAXIS-UTIB0000000-${rrn(2)}-AUTOPAY`, debit: 12900, ref: REF(rrn(2)) },
    { day: 7, narration: `UPI-AUTOPAY-SPOTIFY INDIA PVT LTD-SPOTIFYINDIA.RZP@HDFCBANK-HDFC0MERUPI-${rrn(3)}-AUTOPAY`, debit: 11900, ref: REF(rrn(3)) },
    // 6-8. identical debit amounts on the same day (different merchants + two to the same merchant)
    { day: 12, narration: `UPI-JUICE CAFE-JUICECAFE@YBL-YESB0YBLUPI-${rrn(4)}-UPI`, debit: 12000, ref: REF(rrn(4)) },
    { day: 12, narration: `UPI-RAPIDO-RAPIDO.PAYU@HDFCBANK-HDFC0MERUPI-${rrn(5)}-UPI`, debit: 12000, ref: REF(rrn(5)) },
    { day: 12, narration: `UPI-RAPIDO-RAPIDO.PAYU@HDFCBANK-HDFC0MERUPI-${rrn(6)}-UPI`, debit: 4500, ref: REF(rrn(6)) },
    // 9. value date differs from transaction date
    { day: 25, valueDay: 26, narration: `UPI-SWIGGY-SWIGGY.PAYU@HDFCBANK-HDFC0MERUPI-${rrn(7)}-PAYMENT FOR ORDER`, debit: 18000, ref: REF(rrn(7)) },
    // 10. payment gateway only - the merchant is unknown
    { day: 18, narration: `UPI-RAZORPAY-RAZORPAY@ICICI-ICIC0000001-${rrn(8)}-PAYMENT`, debit: 34900, ref: REF(rrn(8)) },
    // credits: two identical 500.00 on the same day + five others (persons); refund credit is above
    { day: 15, narration: `UPI-ANITA VERMA-ANITA.VERMA@OKSBI-SBIN0001234-${rrn(9)}-UPI`, credit: 50000, ref: REF(rrn(9)) },
    { day: 15, narration: `UPI-KARTHIK NAIR-KARTHIKN@OKICICI-ICIC0004321-${rrn(10)}-UPI`, credit: 50000, ref: REF(rrn(10)) },
    { day: 9, narration: `UPI-PRIYA MENON-PRIYA.M@OKAXIS-UTIB0000555-${rrn(11)}-REIMBURSEMENT`, credit: 100000, ref: REF(rrn(11)) },
    { day: 20, narration: `UPI-ROHAN GUPTA-ROHAN.G@YBL-YESB0YBLUPI-${rrn(12)}-UPI`, credit: 120000, ref: REF(rrn(12)) },
    { day: 22, narration: `UPI-MEERA IYER-MEERA@OKHDFCBANK-HDFC0001111-${rrn(13)}-UPI`, credit: 80000, ref: REF(rrn(13)) },
    { day: 28, narration: `UPI-SAMEER KHAN-SAMEERK@PAYTM-PYTM0123456-${rrn(14)}-UPI`, credit: 90000, ref: REF(rrn(14)) },
    { day: 30, narration: `UPI-DEEPA RAO-DEEPARAO@OKSBI-SBIN0009999-${rrn(15)}-UPI`, credit: 70200, ref: REF(rrn(15)) },
  ];
}

const MERCHANTS: [string, string, string][] = [
  ["ZEPTO", "ZEPTO.RZP@HDFCBANK", "HDFC0MERUPI"],
  ["BLINKIT", "BLINKIT.RZP@HDFCBANK", "HDFC0MERUPI"],
  ["SWIGGY", "SWIGGY.PAYU@HDFCBANK", "HDFC0MERUPI"],
  ["JUICE CAFE", "JUICECAFE@YBL", "YESB0YBLUPI"],
  ["BIG SAVE", "BIGSAVE@OKAXIS", "UTIB0000000"],
  ["GOOGLE INDIA DIGITAL SERVICES", "GOOGLEINDIA@OKAXIS", "UTIB0000000"],
  ["RAPIDO", "RAPIDO.PAYU@HDFCBANK", "HDFC0MERUPI"],
  ["UNSTOP", "UNSTOP.RZP@HDFCBANK", "HDFC0MERUPI"],
  ["MOHAN LAL", "MOHANLAL77@OKHDFCBANK", "HDFC0002222"],
  ["SUNITA DEVI", "SUNITA.D@YBL", "YESB0YBLUPI"],
];

function lcg(seed: number) {
  let a = seed >>> 0;
  return () => ((a = (Math.imul(a, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export const OFFICIAL: OfficialFigures = {
  openingBalance: 29004.97,
  debitCount: 76,
  creditCount: 8,
  totalDebits: 12379.76,
  totalCredits: 5868.0,
  closingBalance: 22493.21,
};

export function buildRealStatement(): { rows: RealRow[]; official: OfficialFigures } {
  const hand = handRows();
  const handDebits = hand.filter((h) => h.debit);
  const handCredits = hand.filter((h) => h.credit);
  if (handDebits.length !== HAND_DEBITS || handCredits.length !== 8) throw new Error("fixture: unexpected hand row counts");

  const targetDebit = Math.round(OFFICIAL.totalDebits * 100);
  const targetCredit = Math.round(OFFICIAL.totalCredits * 100);
  if (handCredits.reduce((a, h) => a + h.credit!, 0) !== targetCredit) throw new Error("fixture: credits do not sum to the official total");

  const bulkCount = OFFICIAL.debitCount - handDebits.length;
  const rnd = lcg(2026);
  const bulk: Spec[] = [];
  for (let i = 0; i < bulkCount; i++) {
    const m = MERCHANTS[i % MERCHANTS.length];
    const day = 1 + Math.floor(rnd() * 31);
    const amount = 3000 + Math.floor(rnd() * 25000); // 30.00 - 280.00
    const note = i % 4 === 0 ? "PAYMENT FOR ORDER" : i % 4 === 1 ? "PAY VIA RAZORPAY" : "UPI";
    bulk.push({ day: Math.min(day, 31), narration: `UPI-${m[0]}-${m[1]}-${m[2]}-${rrn(100 + i)}-${note}`, debit: amount, ref: REF(rrn(100 + i)) });
  }
  // The last bulk debit absorbs the remainder so the total is EXACTLY the official figure.
  const rest = targetDebit - handDebits.reduce((a, h) => a + h.debit!, 0) - bulk.slice(0, -1).reduce((a, b) => a + b.debit!, 0);
  if (rest < 500 || rest > 60000) throw new Error(`fixture: remainder ${rest} out of range; tweak the seed`);
  bulk[bulk.length - 1].debit = rest;

  // Chronological order; hand rows keep their relative order on the same day (debit before its refund).
  const all = [...hand, ...bulk].map((s, i) => ({ s, i })).sort((a, b) => a.s.day - b.s.day || a.i - b.i);
  let bal = Math.round(OFFICIAL.openingBalance * 100);
  const rows: RealRow[] = all.map(({ s }) => {
    bal += (s.credit ?? 0) - (s.debit ?? 0);
    const d = `2026-08-${String(s.day).padStart(2, "0")}`;
    const v = `2026-08-${String(s.valueDay ?? s.day).padStart(2, "0")}`;
    return { date: d, valueDate: v, narration: s.narration, reference: s.ref!, debit: p2r(s.debit ?? 0), credit: p2r(s.credit ?? 0), balance: p2r(bal) };
  });
  if (bal !== Math.round(OFFICIAL.closingBalance * 100)) throw new Error(`fixture: closing ${bal} != official`);
  return { rows, official: OFFICIAL };
}
