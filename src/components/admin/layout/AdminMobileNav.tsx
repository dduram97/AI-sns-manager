"use client";

import Link from "next/link";
import { cn } from "@/lib/utils";
import {
  naverAdminNav,
  snsMenus,
  type SnsMenuItem,
} from "@/components/shell/snsMenus";

export function AdminMobileNav({
  pathname,
  onSelectDisabledSns,
}: {
  pathname: string;
  onSelectDisabledSns: (item: SnsMenuItem) => void;
}) {
  return (
    <div className="sticky top-0 z-30 border-b border-border/70 bg-background/95 backdrop-blur md:hidden">
      <div className="mx-auto flex max-w-lg items-center gap-2 overflow-x-auto px-4 py-2.5">
        {snsMenus.map((item) => {
          const active = item.enabled && item.id === "naver";
          const className = cn(
            "inline-flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium",
            active
              ? "bg-primary text-primary-foreground"
              : "bg-secondary text-secondary-foreground",
          );

          if (item.enabled && item.href) {
            return (
              <Link key={item.id} href={item.href} className={className}>
                <span
                  className={cn(
                    "h-1.5 w-1.5 rounded-full",
                    active ? "bg-emerald-300" : "bg-emerald-500",
                  )}
                />
                {item.name}
              </Link>
            );
          }

          return (
            <button
              key={item.id}
              type="button"
              className={className}
              onClick={() => onSelectDisabledSns(item)}
            >
              <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
              {item.name}
            </button>
          );
        })}
      </div>

      <div className="mx-auto flex max-w-lg gap-1 overflow-x-auto px-4 pb-2.5">
        {naverAdminNav.map((item) => {
          const active = item.match(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "shrink-0 rounded-md px-2.5 py-1 text-xs font-medium",
                active
                  ? "bg-secondary text-foreground"
                  : "text-muted-foreground",
              )}
            >
              {item.label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
