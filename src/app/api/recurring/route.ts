import { readJson, route } from "@/lib/auth/guard";
import { isValidCategory } from "@/lib/domain/categories";
import { ApiError } from "@/lib/auth/guard";
import { merchantKeyOf } from "@/lib/classification/merchants";
import { recurringInputSchema } from "@/lib/services/schemas";
import { createRecurring, detectSeries, getCommitments, getDismissedKeys, listRecurringRows } from "@/lib/services/planning";

export const GET = route(async ({ user }) => {
  const rows = listRecurringRows(user.id);
  const manual = rows.filter((r) => r.source === "manual" && r.status === "active");
  const dismissed = getDismissedKeys(user.id);
  const trackedKeys = new Set(manual.map((m) => m.merchantKey).filter(Boolean));
  const detected = detectSeries(user.id).map((s) => ({
    ...s,
    merchantKey: merchantKeyOf(s.merchant),
    dismissed: dismissed.has(merchantKeyOf(s.merchant)),
    tracked: trackedKeys.has(merchantKeyOf(s.merchant)),
  }));
  return { manual, detected, estimatedMonthlyTotal: getCommitments(user.id) };
});

export const POST = route(async ({ req, user }) => {
  const b = await readJson(req, recurringInputSchema);
  if (!isValidCategory(b.category)) throw new ApiError(400, "BAD_CATEGORY", "Unknown category.");
  const id = createRecurring(user.id, { ...b, source: "manual" });
  return { id };
});
