"use client";

import { useNeighborPage, type NeighborTab } from "@/components/neighbor/NeighborPageContext";

const TABS: Array<[NeighborTab, string]> = [
  ["candidates", "추천 이웃"],
  ["completed", "신청 관리"],
  ["manage", "이웃 관리"],
  ["excluded", "제외"],
  ["feed", "이웃 새글"],
  ["settings", "설정"],
];

export function NeighborTabBar() {
  const { tab, setTab } = useNeighborPage();

  return (
    <div className="flex flex-wrap gap-1 rounded-xl border border-border/70 bg-secondary/40 p-1">
      {TABS.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => setTab(id)}
          className={`flex-1 rounded-lg px-2 py-2 text-xs font-medium ${
            tab === id
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
