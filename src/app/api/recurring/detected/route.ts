import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { readJson, route } from "@/lib/auth/guard";
import { merchantKeyOf } from "@/lib/classification/merchants";
import { bumpDataVersion } from "@/lib/services/data";
import { createRecurring } from "@/lib/services/planning";

const schema = z.object({
  action: z.enum(["track", "dismiss", "restore"]),
  merchant: z.string().trim().min(1).max(120),
  amount: z.number().finite().nonnegative().optional(),
  frequency: z.enum(["weekly", "biweekly", "monthly", "quarterly", "yearly"]).optional(),
  category: z.string().max(60).optional(),
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
});

/** Act on a *detected* recurring payment: pin it as a tracked obligation, dismiss it, or restore it. */
export const POST = route(async ({ req, user }) => {
  const b = await readJson(req, schema);
  const key = merchantKeyOf(b.merchant);
  const db = getDb();
  if (b.action === "restore") {
    db.prepare("DELETE FROM recurring_expenses WHERE user_id = ? AND merchant_key = ? AND status = 'dismissed'").run(user.id, key);
  } else if (b.action === "dismiss") {
    db.prepare("DELETE FROM recurring_expenses WHERE user_id = ? AND merchant_key = ? AND status = 'dismissed'").run(user.id, key);
    createRecurring(user.id, { name: b.merchant, amount: b.amount ?? 0, frequency: b.frequency ?? "monthly", category: b.category ?? "BILLS", merchantKey: key, source: "detected", status: "dismissed" });
  } else {
    createRecurring(user.id, { name: b.merchant, amount: b.amount ?? 0, frequency: b.frequency ?? "monthly", category: b.category ?? "BILLS", dueDay: b.dueDay ?? null, merchantKey: key, source: "manual" });
  }
  bumpDataVersion(user.id);
  return { ok: true };
});
