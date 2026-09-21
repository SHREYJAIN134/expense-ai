import { route } from "@/lib/auth/guard";
import { getUpcoming } from "@/lib/services/planning";

export const GET = route(async ({ req, user }) => {
  const days = Math.min(365, Math.max(1, Number(req.nextUrl.searchParams.get("days") ?? 30) || 30));
  return getUpcoming(user.id, days);
});
