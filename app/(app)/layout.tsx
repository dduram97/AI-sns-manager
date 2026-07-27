import { AppShell } from "@/components/shell/AppShell";
import { QueryProvider } from "@/components/providers/QueryProvider";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <QueryProvider>
      <AppShell>{children}</AppShell>
    </QueryProvider>
  );
}
