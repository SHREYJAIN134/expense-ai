import bcrypt from "bcryptjs";

const COST = 12;
// Compared against when the email is unknown so response time does not reveal
// whether an account exists. Generated lazily (one bcrypt round) and reused.
let dummyHash: string | null = null;
const getDummyHash = () => (dummyHash ??= bcrypt.hashSync("expense-ai-dummy-password", COST));

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, COST);
}

export async function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  return bcrypt.compare(plain, hash ?? getDummyHash()).then((ok) => ok && hash !== null);
}

export interface PasswordCheck {
  ok: boolean;
  message?: string;
}

/** Deliberately simple policy for a single-user app: length matters most. */
export function checkPasswordStrength(pw: string): PasswordCheck {
  if (pw.length < 10) return { ok: false, message: "Password must be at least 10 characters." };
  if (pw.length > 128) return { ok: false, message: "Password is too long (max 128)." };
  if (/^(.)\1+$/.test(pw)) return { ok: false, message: "Password is too repetitive." };
  if (/^(password|12345678|qwertyuiop|letmein)/i.test(pw)) return { ok: false, message: "Password is too easy to guess." };
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((r) => r.test(pw)).length;
  if (classes < 2) return { ok: false, message: "Use a mix of letters, numbers or symbols." };
  return { ok: true };
}
