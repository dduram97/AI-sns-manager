"use client";

import { useCallback, useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { AdminMobileNav } from "@/components/admin/layout/AdminMobileNav";
import { AppSidebar } from "./AppSidebar";
import { ComingSoonModal } from "./ComingSoonModal";
import { TabBar } from "./TabBar";
import type { SnsMenuItem } from "./snsMenus";

const COLLAPSE_KEY = "app.sidebar.collapsed";
const LEGACY_COLLAPSE_KEY = "admin.sidebar.collapsed";

export function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname() || "/today";
  const isAdmin = pathname.startsWith("/admin");
  const [collapsed, setCollapsed] = useState(false);
  const [comingSoon, setComingSoon] = useState<SnsMenuItem | null>(null);

  useEffect(() => {
    try {
      const raw =
        window.localStorage.getItem(COLLAPSE_KEY) ??
        window.localStorage.getItem(LEGACY_COLLAPSE_KEY);
      if (raw === "1") setCollapsed(true);
    } catch {
      // ignore
    }
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(COLLAPSE_KEY, next ? "1" : "0");
      } catch {
        // ignore
      }
      return next;
    });
  }, []);

  const onSelectDisabledSns = useCallback((item: SnsMenuItem) => {
    setComingSoon(item);
  }, []);

  return (
    <div className="min-h-dvh md:flex">
      <AppSidebar
        pathname={pathname}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        onSelectDisabledSns={onSelectDisabledSns}
      />

      <div className="flex min-w-0 flex-1 flex-col">
        {isAdmin ? (
          <AdminMobileNav
            pathname={pathname}
            onSelectDisabledSns={onSelectDisabledSns}
          />
        ) : null}
        <main className="min-w-0 flex-1">{children}</main>
      </div>

      <TabBar />

      <ComingSoonModal
        open={Boolean(comingSoon)}
        message={
          comingSoon?.comingSoonMessage ??
          "해당 SNS 자동화 기능은 준비 중입니다."
        }
        onClose={() => setComingSoon(null)}
      />
    </div>
  );
}
