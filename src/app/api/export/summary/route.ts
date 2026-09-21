import { route } from "@/lib/auth/guard";
import { summaryCsv } from "@/lib/services/export";
import { parseFilter } from "@/lib/services/analytics";

export const GET = route(async ({ req, user }) => {
  const csv = summaryCsv(user.id, parseFilter(req.nextUrl.searchParams));
  return new Response("﻿" + csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="expense-ai-summary-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
});
