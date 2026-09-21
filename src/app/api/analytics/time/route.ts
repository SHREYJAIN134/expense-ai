import { ApiError, route } from "@/lib/auth/guard";
import { getTimeLens } from "@/lib/services/timelens";

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** One window of the ledger for the Time lens: the Strip, comparison with the previous period, and records. */
export const GET = route(async ({ req, user }) => {
  const sp = req.nextUrl.searchParams;
  const from = sp.get("from") ?? "";
  const to = sp.get("to") ?? "";
  if (!ISO.test(from) || !ISO.test(to) || from > to) {
    throw new ApiError(400, "VALIDATION", "from and to must be valid dates (YYYY-MM-DD), from ≤ to.");
  }
  return { lens: getTimeLens(user.id, from, to, sp.get("label")?.slice(0, 40) || "this period") };
});
