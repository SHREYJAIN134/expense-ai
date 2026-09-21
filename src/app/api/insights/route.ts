import { route } from "@/lib/auth/guard";
import { loadAllTxns } from "@/lib/services/data";
import { regenerateInsights, storedInsights } from "@/lib/services/planning";

export const GET = route(async ({ user }) => {
  let insights = storedInsights(user.id);
  if (!insights.length && loadAllTxns(user.id).length) {
    regenerateInsights(user.id);
    insights = storedInsights(user.id);
  }
  return { insights };
});

export const POST = route(async ({ user }) => {
  regenerateInsights(user.id);
  return { insights: storedInsights(user.id) };
});
