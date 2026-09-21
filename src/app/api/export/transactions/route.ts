import { route } from "@/lib/auth/guard";
import { transactionsCsv } from "@/lib/services/export";
import { exportTransactions } from "@/lib/services/transactions";
import { transactionQuerySchema } from "@/lib/services/schemas";

/** Same filters as the explorer, so "export what I'm looking at" works. Omit filters for everything. */
export const GET = route(async ({ req, user }) => {
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  for (const k of Object.keys(sp)) if (sp[k] === "") delete sp[k];
  const q = transactionQuerySchema.parse(sp);
  const csv = transactionsCsv(exportTransactions(user.id, { ...q, lowConfidence: !!q.lowConfidence }));
  return new Response("﻿" + csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="expense-ai-transactions-${new Date().toISOString().slice(0, 10)}.csv"`,
      "cache-control": "no-store",
    },
  });
});
