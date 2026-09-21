import { z } from "zod";
import { ApiError, readJson, route } from "@/lib/auth/guard";
import { getTransaction, updateTransaction } from "@/lib/services/transactions";

export const GET = route<{ id: string }>(async ({ user, params }) => {
  const t = getTransaction(user.id, params.id);
  if (!t) throw new ApiError(404, "NOT_FOUND", "Transaction not found.");
  return { transaction: t };
});

const patch = z
  .object({
    category: z.string().max(60).optional(),
    subcategory: z.string().max(60).optional(),
    merchant: z.string().trim().min(1).max(120).optional(),
    notes: z.string().max(1000).nullable().optional(),
    applyToSimilar: z.boolean().optional(),
  })
  .strict();

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  const body = await readJson(req, patch);
  return updateTransaction(user.id, params.id, body);
});
