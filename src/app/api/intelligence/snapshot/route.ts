import { route } from "@/lib/auth/guard";
import type { PeriodUnit } from "@/lib/analytics/compare";
import { getSnapshot } from "@/lib/services/intelligence";

const UNITS = new Set(["day", "week", "month", "quarter", "year"]);

/** Optional anchor date (YYYY-MM-DD): lets the UI describe the latest month with data when statements are stale. */
const asOfParam = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);

/** Financial Snapshot for the current day / week / month / quarter / year vs the previous equivalent period. */
export const GET = route(async ({ req, user }) => {
  const u = req.nextUrl.searchParams.get("period") ?? "month";
  return { snapshot: getSnapshot(user.id, (UNITS.has(u) ? u : "month") as PeriodUnit, asOfParam(req.nextUrl.searchParams.get("asOf"))) };
});
