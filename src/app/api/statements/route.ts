import { route } from "@/lib/auth/guard";
import { listStatements } from "@/lib/pipeline/import";

export const GET = route(async ({ user }) => ({ statements: listStatements(user.id) }));
