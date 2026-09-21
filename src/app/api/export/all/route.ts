import { route } from "@/lib/auth/guard";
import { fullExport } from "@/lib/services/export";

export const GET = route(async ({ user }) => {
  return new Response(JSON.stringify(fullExport(user.id), null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="expense-ai-full-export-${new Date().toISOString().slice(0, 10)}.json"`,
      "cache-control": "no-store",
    },
  });
});
