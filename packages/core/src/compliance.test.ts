import { describe, expect, it } from "vitest";
import { resolveFlag, scanCompliance } from "./compliance";

const auditContext = {
  workspaceId: "workspace-1",
  actorId: "reviewer-1",
  entityId: "listing-1"
};

type TestAuditEvent = {
  workspaceId: string;
  actorId: string;
  entityId: string;
  action: string;
  metadata: Record<string, unknown>;
};

function createAuditWriter() {
  const events: TestAuditEvent[] = [];
  return {
    events,
    writer: {
      async write(event: TestAuditEvent) {
        events.push(event);
      }
    }
  };
}

describe("scanCompliance", () => {
  it("returns deterministic blocking flags for guaranteed health benefits", () => {
    expect(scanCompliance({ description: "Guaranteed health benefits" })).toEqual([
      {
        id: "description:health_claim:0",
        field: "description",
        rule: "health_claim",
        severity: "blocking",
        status: "open",
        resolutionReason: null
      },
      {
        id: "description:guarantee:1",
        field: "description",
        rule: "guarantee",
        severity: "blocking",
        status: "open",
        resolutionReason: null
      }
    ]);
  });

  it("returns no flags when copy contains no blocking claims", () => {
    expect(scanCompliance({ title: "Estate-bottled red wine" })).toEqual([]);
  });

  it("blocks Chinese health claims and guarantees", () => {
    expect(scanCompliance({ description: "保證有保健功效" })).toEqual([
      expect.objectContaining({ rule: "health_claim", severity: "blocking" }),
      expect.objectContaining({ rule: "guarantee", severity: "blocking" })
    ]);
  });
});

describe("resolveFlag", () => {
  const flag = scanCompliance({ description: "Guaranteed quality" })[0]!;

  it("rejects a resolution reason shorter than ten meaningful characters without auditing", async () => {
    const { events, writer } = createAuditWriter();

    await expect(
      Promise.resolve().then(() =>
        resolveFlag(flag, " too short ", auditContext, writer)
      )
    ).rejects.toThrow("A meaningful resolution reason is required");
    expect(events).toEqual([]);
  });

  it("resolves and audits a flag without mutating the original", async () => {
    const { events, writer } = createAuditWriter();

    const resolved = await resolveFlag(
      flag,
      "  Claim removed from description.  ",
      auditContext,
      writer
    );

    expect(resolved).toEqual({
      ...flag,
      status: "resolved",
      resolutionReason: "Claim removed from description."
    });
    expect(flag).toMatchObject({ status: "open", resolutionReason: null });
    expect(events).toEqual([
      {
        ...auditContext,
        action: "compliance.flag_resolved",
        metadata: {
          flagId: flag.id,
          field: flag.field,
          rule: flag.rule,
          resolutionReason: "Claim removed from description."
        }
      }
    ]);
  });

  it("propagates audit writer failure without mutating the original flag", async () => {
    const writer = {
      async write() {
        throw new Error("audit unavailable");
      }
    };

    await expect(
      resolveFlag(
        flag,
        "Claim removed from description.",
        auditContext,
        writer
      )
    ).rejects.toThrow("audit unavailable");
    expect(flag).toMatchObject({ status: "open", resolutionReason: null });
  });
});
