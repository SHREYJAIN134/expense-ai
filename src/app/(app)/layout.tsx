import { redirect } from "next/navigation";
import Shell from "@/components/Shell";
import { ToastProvider } from "@/components/ui";
import { getCurrentUser } from "@/lib/auth/session";

// Every page in this group needs a valid, database-backed session.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return (
    <ToastProvider>
      <Shell user={{ name: user.name, email: user.email }}>{children}</Shell>
    </ToastProvider>
  );
}
