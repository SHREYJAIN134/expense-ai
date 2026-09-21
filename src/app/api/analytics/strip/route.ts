import { route } from "@/lib/auth/guard";
import { getStrip, type StripView } from "@/lib/services/strip";

const VIEWS = new Set(["week", "month", "quarter", "year"]);

/** The Strip: daily in / spent / moved / balance for a window, plus the estimated path that follows it. */
export const GET = route(async ({ req, user }) => {
  const v = req.nextUrl.searchParams.get("view") ?? "month";
  return { strip: getStrip(user.id, (VIEWS.has(v) ? v : "month") as Exclude<StripView, "custom">) };
});
