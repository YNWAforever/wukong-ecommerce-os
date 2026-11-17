import { getSkill } from "@wukong/core";

import type { StudioCopyKey } from "../studio-copy";

/**
 * The reviewed agent catalogue behind both the Studio home quick-fill cards and
 * `/studio/agents`.
 *
 * Availability is derived from the reviewed skill registry, never hard-coded:
 * a pilot skill is interactive, a planned skill states that it is planned, and
 * a blocked skill stays unavailable. The one entry with no skill behind it
 * (`seo.merchant`) is explicitly marked planned so it can never become
 * clickable by accident.
 */
export type StudioAvailability = "ready" | "pilot" | "planned" | "unavailable";

export type StudioAgentGroup = "core" | "advanced" | "operations";

export type StudioAgent = {
  readonly id: string;
  readonly availability: StudioAvailability;
  readonly group: StudioAgentGroup;
  readonly titleKey: StudioCopyKey;
  readonly outcomeKey: StudioCopyKey;
  readonly limitationKey: StudioCopyKey;
  /** Copy filled into the composer when a pilot agent is used. */
  readonly starterKey?: StudioCopyKey;
  /** Marketed agent that has no reviewed skill yet. */
  readonly planned?: true;
};

export const AVAILABILITY_KEY: Record<StudioAvailability, StudioCopyKey> = {
  ready: "studio.availability.ready",
  pilot: "studio.availability.pilot",
  planned: "studio.availability.planned",
  unavailable: "studio.availability.unavailable",
};

export const AGENT_GROUP_KEYS: Record<StudioAgentGroup, StudioCopyKey> = {
  core: "studio.agents.group.core",
  advanced: "studio.agents.group.advanced",
  operations: "studio.agents.group.operations",
};

export const AGENT_GROUP_ORDER: readonly StudioAgentGroup[] = [
  "core",
  "advanced",
  "operations",
];

function templateAvailability(id: string): StudioAvailability {
  const skill = getSkill(id);
  if (skill?.status === "pilot") return "pilot";
  if (skill?.status === "planned") return "planned";
  return "unavailable";
}

type StudioAgentDefinition = Omit<StudioAgent, "availability">;

const STUDIO_AGENT_DEFINITIONS: readonly StudioAgentDefinition[] = [
  {
    id: "catalog.find",
    group: "operations",
    titleKey: "studio.template.catalogFind.title",
    outcomeKey: "studio.template.catalogFind.outcome",
    limitationKey: "studio.template.catalogFind.limitation",
    starterKey: "studio.template.catalogFind.starter",
  },
  {
    id: "catalog.gap_review",
    group: "operations",
    titleKey: "studio.template.standards.title",
    outcomeKey: "studio.template.standards.outcome",
    limitationKey: "studio.template.standards.limitation",
    starterKey: "studio.template.standards.starter",
  },
  {
    id: "listing.draft_from_sources",
    group: "core",
    titleKey: "studio.template.listingDraft.title",
    outcomeKey: "studio.template.listingDraft.outcome",
    limitationKey: "studio.template.listingDraft.limitation",
    starterKey: "studio.template.listingDraft.starter",
  },
  {
    id: "product_shot.prepare",
    group: "core",
    titleKey: "studio.template.productShot.title",
    outcomeKey: "studio.template.productShot.outcome",
    limitationKey: "studio.template.productShot.limitation",
    starterKey: "studio.template.productShot.starter",
  },
  {
    id: "listing.copy_proposal",
    group: "core",
    titleKey: "studio.template.copyProposal.title",
    outcomeKey: "studio.template.copyProposal.outcome",
    limitationKey: "studio.template.copyProposal.limitation",
    starterKey: "studio.template.copyProposal.starter",
  },
  {
    id: "category.map_proposal",
    group: "advanced",
    titleKey: "studio.template.categoryMapping.title",
    outcomeKey: "studio.template.categoryMapping.outcome",
    limitationKey: "studio.template.categoryMapping.limitation",
    starterKey: "studio.template.categoryMapping.starter",
  },
  {
    id: "supplier.intel_proposal",
    group: "advanced",
    titleKey: "studio.template.supplierIntel.title",
    outcomeKey: "studio.template.supplierIntel.outcome",
    limitationKey: "studio.template.supplierIntel.limitation",
    starterKey: "studio.template.supplierIntel.starter",
  },
  {
    id: "customer.reply_draft",
    group: "advanced",
    titleKey: "studio.template.customerReply.title",
    outcomeKey: "studio.template.customerReply.outcome",
    limitationKey: "studio.template.customerReply.limitation",
  },
  {
    id: "seo.merchant",
    group: "advanced",
    planned: true,
    titleKey: "studio.template.seo.title",
    outcomeKey: "studio.template.seo.outcome",
    limitationKey: "studio.template.seo.limitation",
  },
  {
    id: "merchant.audit",
    group: "operations",
    titleKey: "studio.template.merchantAudit.title",
    outcomeKey: "studio.template.merchantAudit.outcome",
    limitationKey: "studio.template.merchantAudit.limitation",
    starterKey: "studio.template.merchantAudit.starter",
  },
  {
    id: "logistics.followup",
    group: "advanced",
    titleKey: "studio.template.logistics.title",
    outcomeKey: "studio.template.logistics.outcome",
    limitationKey: "studio.template.logistics.limitation",
  },
];

export const STUDIO_AGENTS: readonly StudioAgent[] =
  STUDIO_AGENT_DEFINITIONS.map((agent) => ({
    ...agent,
    availability: agent.planned ? "planned" : templateAvailability(agent.id),
  }));

export function agentById(id: string): StudioAgent | undefined {
  return STUDIO_AGENTS.find((agent) => agent.id === id);
}

export function agentsInGroup(group: StudioAgentGroup): readonly StudioAgent[] {
  return STUDIO_AGENTS.filter((agent) => agent.group === group);
}
