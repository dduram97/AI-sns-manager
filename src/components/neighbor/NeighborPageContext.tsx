"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";

export type NeighborTab =
  | "candidates"
  | "completed"
  | "manage"
  | "excluded"
  | "feed"
  | "settings";

const TAB_IDS = new Set<NeighborTab>([
  "candidates",
  "completed",
  "manage",
  "excluded",
  "feed",
  "settings",
]);

function parseNeighborTab(value: string | null): NeighborTab | null {
  if (!value || !TAB_IDS.has(value as NeighborTab)) return null;
  return value as NeighborTab;
}

type NeighborPageContextValue = {
  tab: NeighborTab;
  setTab: (tab: NeighborTab) => void;
  setQuotaHint: (hint: string) => void;
  quotaHint: string | null;
};

const NeighborPageContext = createContext<NeighborPageContextValue | null>(
  null,
);

export function NeighborPageProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const searchParams = useSearchParams();
  const tabFromUrl = parseNeighborTab(searchParams.get("tab"));
  const [tab, setTab] = useState<NeighborTab>(tabFromUrl ?? "manage");
  const [quotaHint, setQuotaHint] = useState<string | null>(null);

  useEffect(() => {
    setTab(tabFromUrl ?? "manage");
  }, [tabFromUrl]);

  const value = useMemo(
    () => ({ tab, setTab, setQuotaHint, quotaHint }),
    [tab, quotaHint],
  );
  return (
    <NeighborPageContext.Provider value={value}>
      {children}
    </NeighborPageContext.Provider>
  );
}

export function useNeighborPage() {
  const ctx = useContext(NeighborPageContext);
  if (!ctx) {
    throw new Error("useNeighborPage must be used within NeighborPageProvider");
  }
  return ctx;
}

export function useNeighborPageOptional() {
  return useContext(NeighborPageContext);
}
