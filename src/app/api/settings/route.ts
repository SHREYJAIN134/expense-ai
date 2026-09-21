import { z } from "zod";
import { readJson, route } from "@/lib/auth/guard";
import { aiConfigured } from "@/lib/ai/provider";
import { getSettings, getUserCategories, updateSettings } from "@/lib/services/users";
import { bumpDataVersion } from "@/lib/services/data";
import { hasDemoData } from "@/lib/services/demo";

export const GET = route(async ({ user }) => ({
  user: { id: user.id, email: user.email, name: user.name },
  settings: getSettings(user.id),
  categories: getUserCategories(user.id),
  ai: { configured: aiConfigured(), provider: process.env.AI_PROVIDER || "anthropic" }, // key itself is never exposed
  hasDemoData: hasDemoData(user.id),
}));

const schema = z
  .object({
    currency: z.enum(["INR", "USD", "EUR", "GBP"]).optional(),
    monthStartDay: z.number().int().min(1).max(28).optional(),
    aiClassification: z.boolean().optional(),
    aiNarration: z.boolean().optional(),
    safetyBuffer: z.number().min(0).max(100_000_000).nullable().optional(),
    changeMinPct: z.number().min(1).max(500).optional(),
    changeMinAmount: z.number().min(0).max(100_000_000).optional(),
    changeMinTxns: z.number().int().min(1).max(50).optional(),
    anomalyMinAmount: z.number().min(0).max(100_000_000).optional(),
    includeDetectedRecurring: z.boolean().optional(),
    reserveBudgets: z.boolean().optional(),
  })
  .strict();

export const PATCH = route(async ({ req, user }) => {
  const settings = updateSettings(user.id, await readJson(req, schema));
  bumpDataVersion(user.id); // month boundaries changed -> recompute analytics
  return { settings };
});
