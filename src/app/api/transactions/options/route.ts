import { route } from "@/lib/auth/guard";
import { filterOptions } from "@/lib/services/transactions";

export const GET = route(async ({ user }) => filterOptions(user.id));
