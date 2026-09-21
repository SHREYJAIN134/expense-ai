import { z } from "zod";
import { getDb, withTransaction } from "@/lib/db/client";
import { ApiError, readJson, route } from "@/lib/auth/guard";
import { verifyPassword } from "@/lib/auth/password";
import { bumpDataVersion } from "@/lib/services/data";
import { getUserById } from "@/lib/services/users";

const schema = z.object({ password: z.string().min(1).max(200), confirm: z.literal("DELETE MY DATA") });

/** Destructive: wipes ALL financial data (statements, transactions, budgets, chat...) but keeps the login. */
export const POST = route(
  async ({ req, user }) => {
    const b = await readJson(req, schema);
    const row = getUserById(user.id);
    if (!row || !(await verifyPassword(b.password, row.password_hash))) throw new ApiError(403, "WRONG_PASSWORD", "Password is incorrect.");
    const db = getDb();
    withTransaction(() => {
      for (const t of ["transactions", "statements", "accounts", "budgets", "recurring_expenses", "financial_goals", "financial_insights", "chat_sessions", "merchant_overrides"]) {
        db.prepare(`DELETE FROM ${t} WHERE user_id = ?`).run(user.id);
      }
    });
    bumpDataVersion(user.id);
    return { ok: true };
  },
  { rate: { name: "destructive", limit: 5, windowMs: 15 * 60_000 } },
);
