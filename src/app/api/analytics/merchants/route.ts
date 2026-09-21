import { route } from "@/lib/auth/guard";
import { getMerchants, parseFilter } from "@/lib/services/analytics";

export const GET = route(async ({ req, user }) =>
  getMerchants(user.id, parseFilter(req.nextUrl.searchParams), req.nextUrl.searchParams.get("includeTransfers") === "1"),
);
