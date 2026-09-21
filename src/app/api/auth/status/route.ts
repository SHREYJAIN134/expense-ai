import { route } from "@/lib/auth/guard";
import { countUsers } from "@/lib/services/users";

/** Public: tells the login page whether to show "create account" (first run) or "sign in". */
export const GET = route(
  async () => {
    const hasUsers = countUsers() > 0;
    return { hasUsers, registrationOpen: !hasUsers || process.env.ALLOW_REGISTRATION !== "false" };
  },
  { auth: false },
);
