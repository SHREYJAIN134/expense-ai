/**
 * SYNTHETIC DEMO DATA - not real financial information.
 *
 * Deterministic generator of HDFC-style narrations and running balances. It is
 * used (1) to seed the optional "demo data" in Settings and (2) to generate
 * sample statement PDFs for parser tests. Nothing here refers to a real person.
 */
import { addDays, addMonths, daysBetween, daysInMonth, isoWeekday, type ISODate } from "../util/dates";
import { round2 } from "../util/money";

export interface SyntheticTxn {
  date: ISODate;
  /** Value date when it differs from `date` (defaults to `date`). */
  valueDate?: ISODate;
  narration: string;
  reference: string;
  debit: number;
  credit: number;
  balance: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CARD = "416021XXXXXX1234";

interface Draft {
  date: ISODate;
  narration: string;
  debit?: number;
  credit?: number;
}

export function generateSyntheticTransactions(opts: {
  start: ISODate;
  end: ISODate;
  seed?: number;
  openingBalance?: number;
}): SyntheticTxn[] {
  const rnd = mulberry32(opts.seed ?? 42);
  const int = (lo: number, hi: number) => Math.floor(lo + rnd() * (hi - lo + 1));
  const amt = (lo: number, hi: number, step = 1) => round2(Math.round((lo + rnd() * (hi - lo)) / step) * step);
  const pick = <T,>(a: T[]): T => a[Math.floor(rnd() * a.length)];
  const digits = (n: number) => Array.from({ length: n }, () => int(0, 9)).join("");
  const upiRef = () => "4" + digits(11);

  const drafts: Draft[] = [];
  const push = (d: Draft) => {
    if (d.date >= opts.start && d.date <= opts.end) drafts.push(d);
  };

  const upi = (name: string, vpa: string, note = "UPI") =>
    `UPI-${name}-${vpa}-YESB0YBLUPI-${upiRef()}-${note}`;

  // Walk months covering the range
  let monthCursor = opts.start.slice(0, 8) + "01";
  while (monthCursor <= opts.end) {
    const y = Number(monthCursor.slice(0, 4));
    const m = Number(monthCursor.slice(5, 7));
    const dim = daysInMonth(y, m);
    const d = (day: number) => `${y}-${String(m).padStart(2, "0")}-${String(Math.min(day, dim)).padStart(2, "0")}`;

    // --- recurring income & obligations
    push({ date: d(1), narration: `NEFT CR-HDFC0000240-ACME TECHNOLOGIES PVT LTD-SAMPLE USER-N${digits(15)}`, credit: 95000 });
    push({ date: d(3), narration: `IMPS-${upiRef()}-MR RAJESH SHARMA-HDFC-XXXXXXXXXX4321-RENT`, debit: 25000 });
    push({ date: d(10) , narration: `IB BILLPAY DR-HDFCVC-BESCOM ELECTRICITY-${digits(10)}`, debit: amt(1800, 3600) });
    push({ date: d(15), narration: `IB BILLPAY DR-HDFCVC-ACT FIBERNET-${digits(10)}`, debit: 1180 });
    push({ date: d(5), narration: upi("JIO PREPAID", "JIOPREPAID@OKAXIS", "MOBILE RECHARGE"), debit: 349 });
    push({ date: d(7), narration: upi("NETFLIX", "NETFLIX.BILLDESK@HDFCBANK", "SUBSCRIPTION"), debit: 649 });
    push({ date: d(12), narration: upi("SPOTIFY", "SPOTIFYINDIA@YBL", "MONTHLY PLAN"), debit: 119 });
    push({ date: d(6), narration: `ACH D- GROWW MUTUAL FUND SIP-${digits(9)}`, debit: 10000 });
    push({ date: d(20), narration: upi("CULT FIT", "CULTFIT@AXISBANK", "GYM MEMBERSHIP"), debit: m % 3 === 0 ? 4500 : 0 });
    if (m % 3 === 0) push({ date: d(28), narration: `CREDIT INTEREST CAPITALISED`, credit: amt(180, 420) });
    if (m % 3 === 0) push({ date: d(28), narration: `SMS ALERT CHGS Q${Math.ceil(m / 3)}`, debit: 17.7 });
    if (m === 9) push({ date: d(4), narration: upi("UDEMY", "UDEMY@OKICICI", "COURSE PURCHASE"), debit: 3499 });
    if (m % 4 === 2) push({ date: d(18), narration: upi("PAPA", "PAPA.SAMPLE@OKHDFCBANK", "FAMILY"), credit: 8000 });
    if (m % 5 === 0) push({ date: d(22), narration: `POS ${CARD} ZARA FASHION`, debit: amt(4000, 9000, 100) });
    if (m === 6) push({ date: d(14), narration: upi("MAKEMYTRIP", "MMTRIP@ICICI", "FLIGHT BOOKING"), debit: 14850 });
    if (m === 8) push({ date: d(9), narration: `POS ${CARD} CROMA ELECTRONICS`, debit: 48990 });
    if (m % 3 === 1) push({ date: d(19), narration: upi("AMAZON PAY", "AMAZONPAY@APL", "REFUND"), credit: amt(499, 1999) });

    // --- daily discretionary spending
    for (let day = 1; day <= dim; day++) {
      const date = d(day);
      const wd = isoWeekday(date);
      const weekend = wd >= 6;
      if (rnd() < (weekend ? 0.75 : 0.5)) {
        const which = rnd();
        if (which < 0.45) push({ date, narration: upi("SWIGGY", "SWIGGY.PAYU@HDFCBANK", "PAYMENT FOR ORDER"), debit: amt(180, 720) });
        else if (which < 0.8) push({ date, narration: upi("ZOMATO", "ZOMATOONLINE@ICICI", "ORDER"), debit: amt(190, 850) });
        else push({ date, narration: `POS ${CARD} ${pick(["STARBUCKS COFFEE", "CAFE COFFEE DAY", "DOMINOS PIZZA", "MCDONALDS", "THIRD WAVE COFFEE"])}`, debit: amt(150, 780) });
      }
      if (rnd() < 0.2) push({ date, narration: upi(pick(["BLINKIT", "ZEPTO", "BIGBASKET"]), "GROCERY@YBL", "GROCERIES"), debit: amt(250, 1600) });
      if (wd === 6 && rnd() < 0.7) push({ date, narration: `POS ${CARD} DMART AVENUE SUPERMARTS`, debit: amt(1400, 4200) });
      if (rnd() < 0.3) push({ date, narration: upi(pick(["UBER INDIA", "OLA CABS", "RAPIDO"]), "RIDE@OKAXIS", "RIDE"), debit: amt(90, 480) });
      if (rnd() < 0.05) push({ date, narration: `POS ${CARD} INDIAN OIL PETROL PUMP`, debit: amt(800, 2200, 50) });
      if (rnd() < 0.09) push({ date, narration: `POS ${CARD} ${pick(["AMAZON PAY INDIA", "FLIPKART", "MYNTRA", "NYKAA"])}`, debit: amt(300, 3200) });
      if (rnd() < 0.03) push({ date, narration: upi("BOOKMYSHOW", "BOOKMYSHOW@ICICI", "MOVIE TICKETS"), debit: amt(300, 1100) });
      if (rnd() < 0.05) push({ date, narration: upi("APOLLO PHARMACY", "APOLLO@OKHDFCBANK", "MEDICINES"), debit: amt(120, 900) });
      if (rnd() < 0.06) {
        push({ date, narration: upi(pick(["ANITA VERMA", "KARTHIK NAIR", "PRIYA MENON", "ROHAN GUPTA"]), "FRIEND@OKSBI", "SPLIT"), debit: amt(200, 2500, 50) });
      }
      if (rnd() < 0.015) push({ date, narration: upi(pick(["ROHAN GUPTA", "PRIYA MENON"]), "FRIEND@OKSBI", "DINNER SPLIT"), credit: amt(300, 1800, 50) });
      if (rnd() < 0.04) push({ date, narration: `ATW-${CARD}-S1AW${digits(6)}-BANGALORE`, debit: pick([1000, 2000, 3000, 5000]) });
    }
    monthCursor = addMonths(monthCursor, 1, 1);
  }

  // Order: by date, keeping insertion order within a date; salary first, spend later.
  const ordered = drafts
    .filter((x) => (x.debit ?? 0) > 0 || (x.credit ?? 0) > 0)
    .map((x, i) => ({ x, i }))
    .sort((a, b) => (a.x.date === b.x.date ? a.i - b.i : a.x.date < b.x.date ? -1 : 1))
    .map((o) => o.x);

  let balance = opts.openingBalance ?? 60000;
  return ordered.map((x) => {
    balance = round2(balance + (x.credit ?? 0) - (x.debit ?? 0));
    return {
      date: x.date,
      narration: x.narration,
      reference: x.narration.match(/-(4\d{11})-/) ? "0000" + x.narration.match(/-(4\d{11})-/)![1] : "0000" + digits(12),
      debit: x.debit ?? 0,
      credit: x.credit ?? 0,
      balance,
    };
  });
}

export function syntheticRangeDays(a: ISODate, b: ISODate): number {
  return daysBetween(a, b);
}

/** Convenience: the range used for the demo dataset (eight full months up to `today`). */
export function demoRange(today: ISODate): { start: ISODate; end: ISODate } {
  const start = addMonths(today.slice(0, 8) + "01", -8, 1);
  return { start, end: addDays(today, -1) };
}
