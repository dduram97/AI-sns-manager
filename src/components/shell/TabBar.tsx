"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { MoreHorizontal, Sun, UserPlus } from "lucide-react";
import { cn } from "@/lib/utils";

const tabs: Array<{
  href: string;
  label: string;
  icon: typeof Sun;
  disabled?: boolean;
}> = [
  { href: "/today", label: "오늘", icon: Sun },
  { href: "/neighbors", label: "이웃", icon: UserPlus },
  { href: "/more", label: "더보기", icon: MoreHorizontal },
];

export function TabBar() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-border/80 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <ul className="mx-auto flex max-w-lg items-stretch justify-around px-2 pb-[env(safe-area-inset-bottom)]">
        {tabs.map((tab) => {
          const active = pathname === tab.href || pathname.startsWith(`${tab.href}/`);
          const Icon = tab.icon;
          const className = cn(
            "flex min-w-[4.5rem] flex-col items-center gap-1 py-2.5 text-[11px] font-medium",
            active ? "text-foreground" : "text-muted-foreground",
            tab.disabled && "opacity-40",
          );

          if (tab.disabled) {
            return (
              <li key={tab.href}>
                <span className={className} aria-disabled>
                  <Icon className="h-5 w-5" strokeWidth={1.75} />
                  {tab.label}
                </span>
              </li>
            );
          }

          return (
            <li key={tab.href}>
              <Link href={tab.href} className={className}>
                <Icon className="h-5 w-5" strokeWidth={active ? 2.25 : 1.75} />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
