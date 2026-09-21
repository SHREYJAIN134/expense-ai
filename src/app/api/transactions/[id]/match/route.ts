import { z } from "zod";
import { readJson, route } from "@/lib/auth/guard";
import { resolveMatch } from "@/lib/services/events";

const body = z.object({ action: z.enum(["merge", "separate"]) }).strict();

/** Decide a potential cross-source match: merge into one financial event, or keep the two entries separate. */
export const POST = route<{ id: string }>(async ({ req, user, params }) => {
  const b = await readJson(req, body);
  return resolveMatch(user.id, params.id, b.action);
});
