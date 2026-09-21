import { route } from "@/lib/auth/guard";
import { getCashflow, parseFilter } from "@/lib/services/analytics";

export const GET = route(async ({ req, user }) => getCashflow(user.id, parseFilter(req.nextUrl.searchParams)));
