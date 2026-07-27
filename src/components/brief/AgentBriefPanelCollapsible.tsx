"use client";

import { ChevronDown } from "lucide-react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

export function AgentBriefPanelCollapsible({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <Collapsible defaultOpen={false} className="border-t border-border/60 pt-4">
      <CollapsibleTrigger className="flex w-full items-center justify-between gap-2 rounded-lg py-2 text-left text-sm font-medium text-muted-foreground transition-colors hover:text-foreground [&[data-state=open]>svg]:rotate-180">
        <span>▼ Agent 상세 정보</span>
        <ChevronDown
          className="h-4 w-4 shrink-0 transition-transform duration-200"
          aria-hidden
        />
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-4 flex flex-col gap-4 data-[state=closed]:hidden">
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
