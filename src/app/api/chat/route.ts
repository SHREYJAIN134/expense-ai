import { z } from "zod";
import { readJson, route } from "@/lib/auth/guard";
import { chatTurn } from "@/lib/chat/service";

const schema = z.object({ message: z.string().min(1).max(1000), sessionId: z.string().uuid().nullable().optional() });

/** question -> intent -> DB/analytics query -> (optional LLM phrasing, number-verified) -> answer */
export const POST = route(
  async ({ req, user }) => {
    const b = await readJson(req, schema);
    return chatTurn(user.id, { message: b.message, sessionId: b.sessionId ?? null });
  },
  { rate: { name: "chat", limit: 60, windowMs: 10 * 60_000 } },
);
