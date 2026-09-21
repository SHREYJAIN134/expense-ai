import { route } from "@/lib/auth/guard";
import { aiConfigured } from "@/lib/ai/provider";
import { getSettings } from "@/lib/services/users";
import { hasDemoData } from "@/lib/services/demo";
import { dataRange } from "@/lib/services/data";

export const GET = route(async ({ user }) => ({
  user: { id: user.id, email: user.email, name: user.name },
  settings: getSettings(user.id),
  hasDemoData: hasDemoData(user.id),
  dataRange: dataRange(user.id),
  aiConfigured: aiConfigured(),
}));
