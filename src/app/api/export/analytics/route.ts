import { route } from "@/lib/auth/guard";
import { summaryRows } from "@/lib/services/export";
import { parseFilter } from "@/lib/services/analytics";

export const GET = route(async ({ req, user }) => {
  const body = JSON.stringify(summaryRows(user.id, parseFilter(req.nextUrl.searchParams)), null, 2);
  return new Response(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="expense-ai-analytics-${new Date().toISOString().slice(0, 10)}.json"`,
      "cache-control": "no-store",
    },
  });
});
