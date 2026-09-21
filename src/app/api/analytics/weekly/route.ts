import { route } from "@/lib/auth/guard";
import { getPeriodSeries, parseFilter } from "@/lib/services/analytics";

export const GET = route(async ({ req, user }) => getPeriodSeries(user.id, "weekly", parseFilter(req.nextUrl.searchParams)));
