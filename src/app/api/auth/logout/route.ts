import { route } from "@/lib/auth/guard";
import { clearSessionCookie, destroySession, getSessionToken } from "@/lib/auth/session";

export const POST = route(
  async () => {
    destroySession(await getSessionToken());
    await clearSessionCookie();
    return { ok: true };
  },
  { auth: false },
);
