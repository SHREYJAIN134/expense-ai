import { z } from "zod";

const iso = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional();
const num = z.coerce.number().finite().nonnegative().optional();

/** Shared query-string schema for the transaction explorer and its CSV export. */
export const transactionQuerySchema = z.object({
  q: z.string().max(200).optional(),
  from: iso,
  to: iso,
  category: z.string().max(60).optional(),
  subcategory: z.string().max(60).optional(),
  merchant: z.string().max(120).optional(),
  direction: z.enum(["debit", "credit"]).optional(),
  minAmount: num,
  maxAmount: num,
  statementId: z.string().uuid().optional(),
  lowConfidence: z.enum(["1", "true"]).optional(),
  source: z.enum(["HDFC", "GOOGLE_PAY"]).optional(),
  matchStatus: z.enum(["potential"]).optional(),
  flag: z.enum(["refund", "recurring", "moved"]).optional(),
  sort: z.enum(["date", "amount", "merchant", "category"]).optional(),
  dir: z.enum(["asc", "desc"]).optional(),
  page: z.coerce.number().int().min(1).max(100000).optional(),
  pageSize: z.coerce.number().int().min(1).max(200).optional(),
});

export const recurringInputSchema = z.object({
  name: z.string().trim().min(1).max(80),
  amount: z.number().finite().nonnegative().max(1e9),
  frequency: z.enum(["weekly", "biweekly", "monthly", "quarterly", "yearly"]),
  dueDay: z.number().int().min(1).max(31).nullable().optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  category: z.string().max(60),
  kind: z.enum(["expense", "income"]).optional(),
  notes: z.string().max(500).nullable().optional(),
});
