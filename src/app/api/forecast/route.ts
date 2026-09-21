import { route } from "@/lib/auth/guard";
import { getForecast } from "@/lib/services/planning";

/** Cash-flow forecast. Always an ESTIMATE: see `assumptions` in the payload. */
export const GET = route(async ({ req, user }) => {
  const sp = req.nextUrl.searchParams;
  const days = Math.min(365, Math.max(1, Number(sp.get("days") ?? 30) || 30));
  const planned = Number(sp.get("planned") ?? 0);
  return getForecast(user.id, { days, planned: Number.isFinite(planned) && planned > 0 ? planned : undefined });
});
