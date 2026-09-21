import { z } from "zod";
import { getDb } from "@/lib/db/client";
import { ApiError, readJson, route } from "@/lib/auth/guard";
import { getUserByEmail } from "@/lib/services/users";

const schema = z.object({ name: z.string().trim().min(1).max(80), email: z.string().trim().toLowerCase().email().max(200) });

export const PATCH = route(async ({ req, user }) => {
  const b = await readJson(req, schema);
  const existing = getUserByEmail(b.email);
  if (existing && existing.id !== user.id) throw new ApiError(409, "EMAIL_TAKEN", "That email is already in use.");
  getDb().prepare("UPDATE users SET name = ?, email = ?, updated_at = datetime('now') WHERE id = ?").run(b.name, b.email, user.id);
  return { user: { id: user.id, name: b.name, email: b.email } };
});
