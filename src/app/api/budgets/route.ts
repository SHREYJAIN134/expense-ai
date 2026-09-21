import { z } from "zod";
import { ApiError, readJson, route } from "@/lib/auth/guard";
import { isValidCategory } from "@/lib/domain/categories";
import { getBudgetStatus, listBudgets, upsertBudget } from "@/lib/services/planning";

export const GET = route(async ({ user }) => ({ budgets: listBudgets(user.id), status: getBudgetStatus(user.id) }));

const schema = z.object({
  category: z.string().max(60),
  amount: z.number().finite().positive().max(1e9),
  alertThreshold: z.number().min(0.1).max(1).optional(),
});

export const POST = route(async ({ req, user }) => {
  const b = await readJson(req, schema);
  if (!isValidCategory(b.category)) throw new ApiError(400, "BAD_CATEGORY", "Unknown category.");
  return { id: upsertBudget(user.id, b) };
});
