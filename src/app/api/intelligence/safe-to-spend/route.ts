import { route } from "@/lib/auth/guard";
import { getSafeToSpend } from "@/lib/services/intelligence";

/** Safe-to-spend estimate with every component that went into it. */
export const GET = route(async ({ user }) => getSafeToSpend(user.id));
