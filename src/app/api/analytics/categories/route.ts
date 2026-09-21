import { route } from "@/lib/auth/guard";
import { getCategories, parseFilter } from "@/lib/services/analytics";

export const GET = route(async ({ req, user }) => getCategories(user.id, parseFilter(req.nextUrl.searchParams)));
