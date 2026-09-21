/** Round to 2 decimals, avoiding binary float drift (0.1 + 0.2). */
export function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function sum(nums: number[]): number {
  let t = 0;
  for (const n of nums) t += n;
  return round2(t);
}

export function mean(nums: number[]): number {
  return nums.length ? sum(nums) / nums.length : 0;
}

export function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function stddev(nums: number[]): number {
  if (nums.length < 2) return 0;
  const m = mean(nums);
  return Math.sqrt(nums.reduce((a, b) => a + (b - m) ** 2, 0) / nums.length);
}

export function quantile(nums: number[], q: number): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function pct(part: number, whole: number): number {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : 0;
}

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 0 });
const inr2 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2, minimumFractionDigits: 2 });

/** ₹12,34,567.5 style (Indian digit grouping). */
export function formatINR(n: number, opts: { sign?: boolean } = {}): string {
  const r = Math.abs(round2(n));
  const abs = (Number.isInteger(r) ? inr : inr2).format(r);
  const sign = n < 0 ? "-" : opts.sign && n > 0 ? "+" : "";
  return `${sign}₹${abs}`;
}

/** Parse a bank-statement amount: "1,23,456.78", "500.00Cr", "(500.00)", "-500". Returns null if not a number. */
export function parseAmount(raw: string): { value: number; sign: "cr" | "dr" | null } | null {
  let s = raw.trim().replace(/[₹\s]/g, "").replace(/^rs\.?/i, "");
  if (!s) return null;
  let sign: "cr" | "dr" | null = null;
  const suffix = s.match(/(cr|dr)\.?$/i);
  if (suffix) {
    sign = suffix[1].toLowerCase() as "cr" | "dr";
    s = s.slice(0, -suffix[0].length);
  }
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (s.startsWith("-")) {
    negative = true;
    s = s.slice(1);
  }
  if (!/^\d{1,3}(,\d{2,3})*(\.\d+)?$|^\d+(\.\d+)?$/.test(s)) return null;
  const v = Number(s.replace(/,/g, ""));
  if (!Number.isFinite(v)) return null;
  // Sign convention here: magnitude is always positive; `negative` is folded into sign hint.
  if (negative && !sign) sign = "dr";
  return { value: round2(v), sign };
}
