import { describe, expect, it } from "vitest";
import { getSkill } from "@wukong/core";

import {
  AGENT_GROUP_ORDER,
  STUDIO_AGENTS,
  agentById,
  agentsInGroup,
} from "./agents";

describe("STUDIO_AGENTS", () => {
  it("publishes one reviewed catalogue entry per agent, including the planned SEO entry", () => {
    expect(STUDIO_AGENTS).toHaveLength(11);
    expect(new Set(STUDIO_AGENTS.map((agent) => agent.id)).size).toBe(11);
    expect(agentById("seo.merchant")).toMatchObject({
      availability: "planned",
      planned: true,
    });
    expect(agentById("does.not.exist")).toBeUndefined();
  });

  it("derives every non-planned availability from the reviewed skill registry", () => {
    for (const agent of STUDIO_AGENTS) {
      if (agent.planned) continue;
      const skill = getSkill(agent.id);
      expect(agent.availability).toBe(
        skill?.status === "pilot"
          ? "pilot"
          : skill?.status === "planned"
            ? "planned"
            : "unavailable",
      );
    }
  });

  it("groups every agent exactly once in core, advanced and operations", () => {
    const grouped = AGENT_GROUP_ORDER.flatMap((group) =>
      agentsInGroup(group).map((agent) => agent.id),
    );
    expect(grouped).toHaveLength(STUDIO_AGENTS.length);
    expect(new Set(grouped).size).toBe(STUDIO_AGENTS.length);
    expect(agentsInGroup("core")).toHaveLength(3);
    expect(agentsInGroup("advanced")).toHaveLength(5);
    expect(agentsInGroup("operations")).toHaveLength(3);
  });

  it("makes only pilot agents interactive and never gives a dead filler to unavailable entries", () => {
    for (const agent of STUDIO_AGENTS) {
      if (agent.availability === "pilot") {
        expect(agent.starterKey, agent.id).toBeDefined();
      } else {
        expect(agent.starterKey, agent.id).toBeUndefined();
      }
    }
  });

  it("keeps the unavailable marketed agents unavailable", () => {
    expect(agentById("customer.reply_draft")?.availability).toBe("unavailable");
    expect(agentById("logistics.followup")?.availability).toBe("unavailable");
  });
});
