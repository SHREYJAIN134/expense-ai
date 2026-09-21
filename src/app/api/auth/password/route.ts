import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { ApiError, readJson, route } from "@/lib/auth/guard";
import { checkPasswordStrength, hashPassword, verifyPassword } from "@/lib/auth/password";
import { destroyAllSessions, getSessionToken } from "@/lib/auth/session";
import { getUserById } from "@/lib/services/users";

const schema = z.object({ current: z.string().min(1).max(200), next: z.string().max(200) });

export const POST = route(
  async ({ req, user }) => {
    const body = await readJson(req, schema);
    const row = getUserById(user.id);
    if (!row || !(await verifyPassword(body.current, row.password_hash))) throw new ApiError(400, "WRONG_PASSWORD", "Current password is incorrect.");
    const pw = checkPasswordStrength(body.next);
    if (!pw.ok) throw new ApiError(400, "WEAK_PASSWORD", pw.message!);
    getDb().prepare("UPDATE users SET password_hash = ?, updated_at = datetime('now') WHERE id = ?").run(await hashPassword(body.next), user.id);
    destroyAllSessions(user.id, await getSessionToken()); // sign out every other device
    return { ok: true };
  },
  { rate: { name: "password", limit: 10, windowMs: 15 * 60_000 } },
);
