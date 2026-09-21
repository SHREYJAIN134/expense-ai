import { z } from "zod";
import { getDb, uid } from "@/lib/db/client";
import { ApiError, readJson, route } from "@/lib/auth/guard";
import { getUserCategories } from "@/lib/services/users";

const name = z.string().trim().min(2).max(40).regex(/^[A-Za-z0-9 &/'.+-]+$/, "Use letters, numbers and simple punctuation only");

export const GET = route(async ({ user }) => ({ categories: getUserCategories(user.id) }));

const add = z.object({ category: name, subcategory: name.optional(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional() });

/** Add a custom category (top-level) or a custom subcategory under an existing category. */
export const POST = route(async ({ req, user }) => {
  const b = await readJson(req, add);
  const db = getDb();
  const category = b.category.toUpperCase();
  const cats = getUserCategories(user.id);
  const existing = cats.find((c) => c.name === category);
  if (b.subcategory) {
    if (!existing) throw new ApiError(404, "NOT_FOUND", "That category does not exist.");
    if (existing.subcategories.some((s) => s.name.toLowerCase() === b.subcategory!.toLowerCase())) throw new ApiError(409, "EXISTS", "That subcategory already exists.");
    db.prepare("INSERT INTO transaction_categories (id, user_id, category, subcategory, color, is_system) VALUES (?, ?, ?, ?, ?, 0)").run(uid(), user.id, category, b.subcategory, existing.color);
  } else {
    if (existing) throw new ApiError(409, "EXISTS", "That category already exists.");
    db.prepare("INSERT INTO transaction_categories (id, user_id, category, subcategory, color, is_system) VALUES (?, ?, ?, '', ?, 0)").run(uid(), user.id, category, b.color ?? "#94a3b8");
  }
  return { categories: getUserCategories(user.id) };
});

const del = z.object({ category: z.string().max(60), subcategory: z.string().max(60).optional() });

/** Only custom categories/subcategories can be removed, and only when no transaction uses them. */
export const DELETE = route(async ({ req, user }) => {
  const b = await readJson(req, del);
  const db = getDb();
  const row = db
    .prepare("SELECT is_system FROM transaction_categories WHERE user_id = ? AND category = ? AND subcategory = ?")
    .get(user.id, b.category, b.subcategory ?? "") as { is_system: number } | undefined;
  if (!row) throw new ApiError(404, "NOT_FOUND", "Category not found.");
  if (row.is_system) throw new ApiError(400, "SYSTEM_CATEGORY", "Built-in categories cannot be removed.");
  const used = (b.subcategory
    ? db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND category = ? AND subcategory = ?").get(user.id, b.category, b.subcategory)
    : db.prepare("SELECT COUNT(*) AS n FROM transactions WHERE user_id = ? AND category = ?").get(user.id, b.category)) as { n: number };
  if (used.n > 0) throw new ApiError(409, "IN_USE", `${used.n} transaction(s) use it. Re-categorise them first.`);
  if (b.subcategory) db.prepare("DELETE FROM transaction_categories WHERE user_id = ? AND category = ? AND subcategory = ?").run(user.id, b.category, b.subcategory);
  else db.prepare("DELETE FROM transaction_categories WHERE user_id = ? AND category = ?").run(user.id, b.category);
  return { categories: getUserCategories(user.id) };
});
