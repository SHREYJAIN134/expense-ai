import { route } from "@/lib/auth/guard";
import { reportHtml } from "@/lib/services/export";
import { parseFilter } from "@/lib/services/analytics";

export const GET = route(async ({ req, user }) => {
  const html = reportHtml(user.id, parseFilter(req.nextUrl.searchParams), user.name);
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-disposition": `attachment; filename="expense-ai-report-${new Date().toISOString().slice(0, 10)}.html"`,
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
    },
  });
});
