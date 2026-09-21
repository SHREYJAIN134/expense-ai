import { route } from "@/lib/auth/guard";
import { getPatterns, parseFilter } from "@/lib/services/analytics";

export const GET = route(async ({ req, user }) => getPatterns(user.id, parseFilter(req.nextUrl.searchParams)));
