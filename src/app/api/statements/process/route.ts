import { z } from "zod";
import { readJson, route } from "@/lib/auth/guard";
import { confirmImport } from "@/lib/pipeline/import";

const schema = z.object({
  statementId: z.string().uuid(),
  /** Must be true to import a statement whose totals do not reconcile with its own summary. */
  acknowledgeReconciliation: z.boolean().optional(),
});

/** Step 6-10: confirm a previewed statement -> atomic import -> analytics refresh. */
export const POST = route(async ({ req, user }) => {
  const { statementId, acknowledgeReconciliation } = await readJson(req, schema);
  return confirmImport(user.id, statementId, { acknowledgeReconciliation });
});
