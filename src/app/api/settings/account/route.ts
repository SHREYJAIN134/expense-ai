import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { ApiError, readJson, route } from "@/lib/auth/guard";
import { verifyPassword } from "@/lib/auth/password";
import { clearSessionCookie } from "@/lib/auth/session";
import { bumpDataVersion } from "@/lib/services/data";
import { getUserById } from "@/lib/services/users";

const schema = z.object({ password: z.string().min(1).max(200), confirm: z.literal("DELETE MY ACCOUNT") });

/** Destructive: deletes the account and, via ON DELETE CASCADE, every row that belongs to it. */
export const DELETE = route(
  async ({ req, user }) => {
    const b = await readJson(req, schema);
    const row = getUserById(user.id);
    if (!row || !(await verifyPassword(b.password, row.password_hash))) throw new ApiError(403, "WRONG_PASSWORD", "Password is incorrect.");
    getDb().prepare("DELETE FROM users WHERE id = ?").run(user.id);
    bumpDataVersion(user.id);
    await clearSessionCookie();
    return { ok: true };
  },
  { rate: { name: "destructive", limit: 5, windowMs: 15 * 60_000 } },
);
