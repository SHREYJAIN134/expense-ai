import { z } from "zod";
import { ApiError, readJson, route } from "@/lib/auth/guard";
import { deleteGoal, updateGoal } from "@/lib/services/planning";

const patch = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    targetAmount: z.number().finite().positive().max(1e10).optional(),
    currentAmount: z.number().finite().nonnegative().max(1e10).optional(),
    targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    status: z.enum(["active", "achieved", "paused"]).optional(),
  })
  .strict();

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  if (!updateGoal(user.id, params.id, await readJson(req, patch))) throw new ApiError(404, "NOT_FOUND", "Goal not found.");
  return { ok: true };
});
export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  if (!deleteGoal(user.id, params.id)) throw new ApiError(404, "NOT_FOUND", "Goal not found.");
  return { ok: true };
});
