import { route } from "@/lib/auth/guard";
import { deleteSession, getSession } from "@/lib/chat/service";

export const GET = route<{ id: string }>(async ({ user, params }) => getSession(user.id, params.id));
export const DELETE = route<{ id: string }>(async ({ user, params }) => {
  deleteSession(user.id, params.id);
  return { ok: true };
});
