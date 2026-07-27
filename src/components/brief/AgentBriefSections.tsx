import {
  AgentBriefPanel,
  type AgentBriefPanelProps,
} from "@/components/brief/AgentBriefPanel";

/** @deprecated Prefer AgentBriefPanel — kept for existing imports. */
export function AgentBriefSections(props: AgentBriefPanelProps = {}) {
  return <AgentBriefPanel {...props} />;
}

export type { AgentBriefPanelProps };
