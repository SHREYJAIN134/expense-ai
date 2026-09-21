import { route } from "@/lib/auth/guard";
import { listSessions } from "@/lib/chat/service";

export const GET = route(async ({ user }) => ({ sessions: listSessions(user.id) }));
