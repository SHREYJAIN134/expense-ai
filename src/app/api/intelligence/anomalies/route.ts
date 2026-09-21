import { route } from "@/lib/auth/guard";
import { getAnomalies } from "@/lib/services/intelligence";

/** Unusual-activity findings (statistical, not a fraud verdict). */
export const GET = route(async ({ req, user }) => {
  const days = Math.min(3650, Math.max(7, Number(req.nextUrl.searchParams.get("days") ?? 90) || 90));
  return { anomalies: getAnomalies(user.id, undefined, { lookbackDays: days }) };
});
