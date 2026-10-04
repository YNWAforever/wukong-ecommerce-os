import { describe, expect, it } from "vitest";
import type { ComplianceFlag } from "./compliance";
import { scanCompliance } from "./compliance";
import {
  approveListing,
  reopenListing,
  validateListingApproval,
} from "./review";

const auditContext = {
  workspaceId: "workspace-1",
  actorId: "reviewer-1",
  entityId: "listing-1",
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
      },
    },
  };
}

describe("validateListingApproval", () => {
  it("returns approval for frozen resolved flags without changing them", () => {
    const scanned = scanCompliance({ description: "Guaranteed quality" })[0]!;
    const flags = Object.freeze([
      Object.freeze({
        ...scanned,
        status: "resolved" as const,
        resolutionReason: "Claim removed from description.",
      }),
    ]);
    const before = structuredClone(flags);
    expect(validateListingApproval("version-2", flags)).toEqual({
      versionId: "version-2",
      status: "approved",
    });
    expect(flags).toEqual(before);
  });

  it("rejects open blocking flags", () => {
    const flags = scanCompliance({ description: "Guaranteed health benefits" });
    expect(() => validateListingApproval("version-1", flags)).toThrow(
      "Blocking compliance flags must be resolved before approval",
    );
  });

  it.each([" short ", undefined])(
    "rejects resolved blocking flags without a meaningful runtime reason (%s)",
    (resolutionReason) => {
      const scanned = scanCompliance({ description: "Guaranteed quality" })[0]!;
      const flag = {
        ...scanned,
        status: "resolved",
        resolutionReason,
      } as ComplianceFlag;
      expect(() => validateListingApproval("version-1", [flag])).toThrow(
        "Blocking compliance flags require a meaningful resolution reason before approval",
      );
    },
  );

  it("permits an open warning without weakening blocking rules", () => {
    const warning: ComplianceFlag = {
      id: "warning-1",
      field: "description",
      rule: "superlative",
      severity: "warning",
      status: "open",
      resolutionReason: null,
    };
    expect(validateListingApproval("version-3", [warning])).toEqual({
      versionId: "version-3",
      status: "approved",
    });
  });
});

describe("approveListing", () => {
  it("rejects approval while a blocking compliance flag remains open without auditing", async () => {
    const flags = scanCompliance({ description: "Guaranteed health benefits" });
    const { events, writer } = createAuditWriter();

    await expect(
      Promise.resolve().then(() =>
        approveListing("version-1", flags, auditContext, writer),
      ),
    ).rejects.toThrow(
      "Blocking compliance flags must be resolved before approval",
    );
    expect(events).toEqual([]);
  });

  it("rejects a blocking resolved flag with a short runtime resolution reason", async () => {
    const scanned = scanCompliance({ description: "Guaranteed quality" })[0]!;
    const invalidFlag = {
      ...scanned,
      status: "resolved",
      resolutionReason: " short ",
    } as ComplianceFlag;
    const { events, writer } = createAuditWriter();

    await expect(
      Promise.resolve().then(() =>
        approveListing("version-1", [invalidFlag], auditContext, writer),
      ),
    ).rejects.toThrow(
      "Blocking compliance flags require a meaningful resolution reason before approval",
    );
    expect(events).toEqual([]);
  });

  it("approves and audits a version without mutating resolved flags", async () => {
    const scanned = scanCompliance({ description: "Guaranteed quality" })[0]!;
    const flags: ComplianceFlag[] = [
      {
        ...scanned,
        status: "resolved",
        resolutionReason: "Claim removed from description.",
      },
    ];
    const snapshot = structuredClone(flags);
    const { events, writer } = createAuditWriter();

    await expect(
      approveListing("version-2", flags, auditContext, writer),
    ).resolves.toEqual({ versionId: "version-2", status: "approved" });
    expect(flags).toEqual(snapshot);
    expect(events).toEqual([
      {
        ...auditContext,
        action: "listing.approved",
        metadata: { versionId: "version-2" },
      },
    ]);
  });

  it("propagates audit writer failure instead of returning approval", async () => {
    const writer = {
      async write() {
        throw new Error("audit unavailable");
      },
    };

    await expect(
      approveListing("version-2", [], auditContext, writer),
    ).rejects.toThrow("audit unavailable");
  });
});

describe("reopenListing", () => {
  it.each(["approved", "published", "publish_failed"] as const)(
    "reopens and audits a %s listing",
    async (status) => {
      const { events, writer } = createAuditWriter();

      await expect(reopenListing(status, auditContext, writer)).resolves.toBe(
        "reopened",
      );
      expect(events).toEqual([
        {
          ...auditContext,
          action: "listing.transition",
          metadata: {
            fromStatus: status,
            action: "reopen",
            toStatus: "reopened",
          },
        },
      ]);
    },
  );

  it("rejects reopening a listing still in review without auditing", async () => {
    const { events, writer } = createAuditWriter();

    await expect(
      Promise.resolve().then(() =>
        reopenListing("in_review", auditContext, writer),
      ),
    ).rejects.toThrow("Illegal transition: in_review -> reopen");
    expect(events).toEqual([]);
  });

  it("propagates audit writer failure instead of returning a reopened state", async () => {
    const writer = {
      async write() {
        throw new Error("audit unavailable");
      },
    };

    await expect(
      reopenListing("approved", auditContext, writer),
    ).rejects.toThrow("audit unavailable");
  });
});
