import { route } from "@/lib/auth/guard";
import { getPeriodSeries, parseFilter } from "@/lib/services/analytics";

export const GET = route(async ({ req, user }) => getPeriodSeries(user.id, "quarterly", parseFilter(req.nextUrl.searchParams)));
