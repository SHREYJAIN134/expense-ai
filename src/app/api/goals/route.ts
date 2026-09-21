import { z } from "zod";
import { readJson, route } from "@/lib/auth/guard";
import { createGoal, listGoals } from "@/lib/services/planning";

const schema = z.object({
  name: z.string().trim().min(1).max(80),
  targetAmount: z.number().finite().positive().max(1e10),
  currentAmount: z.number().finite().nonnegative().max(1e10).optional(),
  targetDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

export const GET = route(async ({ user }) => ({ goals: listGoals(user.id) }));
export const POST = route(async ({ req, user }) => ({ id: createGoal(user.id, await readJson(req, schema)) }));
