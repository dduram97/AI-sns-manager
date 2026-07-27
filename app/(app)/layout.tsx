import { TabBar } from "@/components/shell/TabBar";
import { QueryProvider } from "@/components/providers/QueryProvider";

export default function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <QueryProvider>
      <main className="min-h-dvh">{children}</main>
      <TabBar />
    </QueryProvider>
  );
}
