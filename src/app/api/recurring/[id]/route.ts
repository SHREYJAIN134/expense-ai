import { z } from "zod";
import { ApiError, readJson, route } from "@/lib/auth/guard";
import { deleteRecurring, updateRecurring } from "@/lib/services/planning";

const patch = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    amount: z.number().finite().nonnegative().max(1e9).optional(),
    frequency: z.enum(["weekly", "biweekly", "monthly", "quarterly", "yearly"]).optional(),
    dueDay: z.number().int().min(1).max(31).nullable().optional(),
    startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    category: z.string().max(60).optional(),
    status: z.enum(["active", "dismissed"]).optional(),
    notes: z.string().max(500).nullable().optional(),
  })
  .strict();

export const PATCH = route<{ id: string }>(async ({ req, user, params }) => {
  if (!updateRecurring(user.id, params.id, await readJson(req, patch))) throw new ApiError(404, "NOT_FOUND", "Not found.");
  return { ok: true };
});

export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  if (!deleteRecurring(user.id, params.id)) throw new ApiError(404, "NOT_FOUND", "Not found.");
  return { ok: true };
});
