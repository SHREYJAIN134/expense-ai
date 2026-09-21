import { route } from "@/lib/auth/guard";
import { transactionQuerySchema } from "@/lib/services/schemas";
import { queryTransactions } from "@/lib/services/transactions";

export const GET = route(async ({ req, user }) => {
  const sp = Object.fromEntries(req.nextUrl.searchParams.entries());
  for (const k of Object.keys(sp)) if (sp[k] === "") delete sp[k];
  const q = transactionQuerySchema.parse(sp);
  return queryTransactions(user.id, { ...q, lowConfidence: !!q.lowConfidence });
});
