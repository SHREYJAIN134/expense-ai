import { route } from "@/lib/auth/guard";
import { getOverview, parseFilter } from "@/lib/services/analytics";

export const GET = route(async ({ req, user }) => getOverview(user.id, parseFilter(req.nextUrl.searchParams)));
