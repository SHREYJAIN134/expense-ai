import { route } from "@/lib/auth/guard";
import { getProjection } from "@/lib/services/intelligence";

/** 7 / 14 / 30-day cash-flow projection. Estimates only - projected values are kept apart from the actual balance. */
export const GET = route(async ({ user }) => getProjection(user.id));
