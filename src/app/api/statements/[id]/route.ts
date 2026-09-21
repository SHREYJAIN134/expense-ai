import { getDb } from "@/lib/db/client";
import { ApiError, route } from "@/lib/auth/guard";
import { deleteStatement, discardStatement, getPreview, listStatements } from "@/lib/pipeline/import";

export const GET = route<{ id: string }>(async ({ user, params }) => {
  const st = listStatements(user.id).find((s) => s.id === params.id);
  if (!st) throw new ApiError(404, "NOT_FOUND", "Statement not found.");
  return { statement: st, preview: st.status === "preview" ? getPreview(user.id, params.id) : null };
});

/** Discards a pending preview, or deletes an imported statement together with its transactions. */
export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  const row = getDb().prepare("SELECT status FROM statements WHERE id = ? AND user_id = ?").get(params.id, user.id) as { status: string } | undefined;
  if (!row) throw new ApiError(404, "NOT_FOUND", "Statement not found.");
  return row.status === "preview" ? discardStatement(user.id, params.id) : deleteStatement(user.id, params.id);
});
