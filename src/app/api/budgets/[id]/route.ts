import { z } from "zod";
import { ApiError, readJson, route } from "@/lib/auth/guard";
import { deleteBudget, updateBudget } from "@/lib/services/planning";

const patch = z
  .object({ amount: z.number().finite().positive().max(1e9).optional(), alertThreshold: z.number().min(0.1).max(1).optional(), isActive: z.boolean().optional() })
  .strict();

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  if (!updateBudget(user.id, params.id, await readJson(req, patch))) throw new ApiError(404, "NOT_FOUND", "Budget not found.");
  return { ok: true };
});

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  if (!deleteBudget(user.id, params.id)) throw new ApiError(404, "NOT_FOUND", "Budget not found.");
  return { ok: true };
});
