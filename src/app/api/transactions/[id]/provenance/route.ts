import { ApiError, route } from "@/lib/auth/guard";
import { getProvenance } from "@/lib/services/events";

/** Every statement row behind one financial event (e.g. the HDFC row and the Google Pay row of the same payment). */
export const GET = route<{ id: string }>(async ({ user, params }) => {
  const p = getProvenance(user.id, params.id);
  if (!p) throw new ApiError(404, "NOT_FOUND", "Transaction not found.");
  return p;
});
