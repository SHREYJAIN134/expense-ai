import { route } from "@/lib/auth/guard";
import { hasDemoData, loadDemoData, removeDemoData } from "@/lib/services/demo";

/** Load clearly-labelled SYNTHETIC demo data (development / trying the dashboards). */
export const POST = route(async ({ user }) => {
  if (hasDemoData(user.id)) return { statements: 0, transactions: 0, alreadyLoaded: true };
  return loadDemoData(user.id);
});

export const DELETE = route(async ({ user }) => removeDemoData(user.id));
