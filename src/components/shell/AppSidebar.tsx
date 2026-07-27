"use client";

import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  appNav,
  naverAdminNav,
  snsMenus,
  type SnsMenuItem,
} from "./snsMenus";

export function AppSidebar({
  pathname,
  collapsed,
  onToggleCollapsed,
  onSelectDisabledSns,
}: {
  pathname: string;
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onSelectDisabledSns: (item: SnsMenuItem) => void;
}) {
  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-dvh shrink-0 flex-col border-r border-border bg-card md:flex",
        collapsed ? "w-[4.5rem]" : "w-60",
      )}
    >
      <div
        className={cn(
          "flex h-14 items-center border-b border-border/70 px-3",
          collapsed ? "justify-center" : "justify-between",
        )}
      >
        {!collapsed ? (
          <div className="min-w-0">
            <p className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              SNS 관리
            </p>
            <p className="truncate text-sm font-semibold tracking-tight">
              AI SNS Manager
            </p>
          </div>
        ) : null}
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="inline-flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground"
          aria-label={collapsed ? "사이드바 펼치기" : "사이드바 접기"}
        >
          {collapsed ? (
            <ChevronRight className="h-4 w-4" />
          ) : (
            <ChevronLeft className="h-4 w-4" />
          )}
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2 py-3">
        {!collapsed ? (
          <p className="mb-2 px-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            채널
          </p>
        ) : null}

        <ul className="space-y-1">
          {snsMenus.map((item) => {
            const active = item.enabled && item.id === "naver";
            const base = cn(
              "flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left text-sm transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-foreground/80 hover:bg-secondary/80",
              collapsed && "justify-center px-0",
            );

            if (item.enabled && item.href) {
              return (
                <li key={item.id}>
                  <Link href={item.href} className={base} title={item.name}>
                    <span
                      className={cn(
                        "h-2 w-2 shrink-0 rounded-full",
                        active ? "bg-emerald-400" : "bg-emerald-500",
                      )}
                      aria-hidden
                    />
                    {!collapsed ? (
                      <span className="truncate font-medium">{item.name}</span>
                    ) : null}
                  </Link>
                </li>
              );
            }

            return (
              <li key={item.id}>
                <button
                  type="button"
                  className={base}
                  title={item.name}
                  onClick={() => onSelectDisabledSns(item)}
                >
                  <span
                    className="h-2 w-2 shrink-0 rounded-full bg-muted-foreground/40"
                    aria-hidden
                  />
                  {!collapsed ? (
                    <span className="truncate">{item.name}</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>

        {!collapsed ? (
          <>
            <div className="my-4 border-t border-border/70" />
            <p className="mb-2 px-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              앱
            </p>
            <ul className="space-y-1">
              {appNav.map((item) => {
                const active = item.match(pathname);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        "block rounded-lg px-2.5 py-2 text-sm transition-colors",
                        active
                          ? "bg-secondary font-medium text-foreground"
                          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>

            <div className="my-4 border-t border-border/70" />
            <p className="mb-2 px-2 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              네이버
            </p>
            <ul className="space-y-1">
              {naverAdminNav.map((item) => {
                const active = item.match(pathname);
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      className={cn(
                        "block rounded-lg px-2.5 py-2 text-sm transition-colors",
                        active
                          ? "bg-secondary font-medium text-foreground"
                          : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                      )}
                    >
                      {item.label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        ) : null}
      </div>
    </aside>
  );
}
