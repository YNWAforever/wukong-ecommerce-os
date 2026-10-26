import { describe, expect, it } from "vitest";
import { transitionListing } from "./workflow";

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

const statuses = [
  "received",
  "processing",
  "needs_info",
  "in_review",
  "approved",
  "reopened",
  "publishing",
  "published",
  "publish_failed",
  "failed",
] as const;

const actions = [
  "abandon_processing",
  "save_inputs",
  "submit_manual",
  "start_processing",
  "request_info",
  "submit_review",
  "approve",
  "reopen",
  "begin_publish",
  "publish_succeeded",
  "publish_failed",
  "fail",
  "retry",
] as const;

const legalTransitions = [
  ["received", "abandon_processing", "failed"],
  ["processing", "abandon_processing", "failed"],
  ["needs_info", "abandon_processing", "failed"],
  ["failed", "abandon_processing", "failed"],
  ["received", "save_inputs", "received"],
  ["processing", "save_inputs", "needs_info"],
  ["needs_info", "save_inputs", "needs_info"],
  ["in_review", "save_inputs", "in_review"],
  ["approved", "save_inputs", "reopened"],
  ["reopened", "save_inputs", "reopened"],
  ["published", "save_inputs", "reopened"],
  ["publish_failed", "save_inputs", "reopened"],
  ["failed", "save_inputs", "failed"],
  ["received", "submit_manual", "in_review"],
  ["processing", "submit_manual", "in_review"],
  ["needs_info", "submit_manual", "in_review"],
  ["failed", "submit_manual", "in_review"],
  ["received", "start_processing", "processing"],
  ["processing", "request_info", "needs_info"],
  ["processing", "submit_review", "in_review"],
  ["processing", "fail", "failed"],
  ["needs_info", "start_processing", "processing"],
  ["in_review", "approve", "approved"],
  ["approved", "reopen", "reopened"],
  ["approved", "begin_publish", "publishing"],
  ["reopened", "submit_review", "in_review"],
  ["publishing", "publish_succeeded", "published"],
  ["publishing", "publish_failed", "publish_failed"],
  ["published", "reopen", "reopened"],
  ["publish_failed", "retry", "publishing"],
  ["publish_failed", "reopen", "reopened"],
  ["failed", "retry", "processing"],
] as const;

const legalPairs = new Set(
  legalTransitions.map(([status, action]) => `${status}:${action}`),
);

describe("transitionListing", () => {
  it.each(legalTransitions)(
    "permits and audits %s -> %s -> %s",
    async (status, action, expected) => {
      const { events, writer } = createAuditWriter();

      await expect(
        transitionListing(status, action, auditContext, writer),
      ).resolves.toBe(expected);
      expect(events).toEqual([
        {
          ...auditContext,
          action: "listing.transition",
          metadata: { fromStatus: status, action, toStatus: expected },
        },
      ]);
    },
  );

  it("rejects every transition outside the independently defined legal pairs", async () => {
    for (const status of statuses) {
      for (const action of actions) {
        if (legalPairs.has(`${status}:${action}`)) continue;
        const { events, writer } = createAuditWriter();

        await expect(
          Promise.resolve().then(() =>
            transitionListing(status, action, auditContext, writer),
          ),
        ).rejects.toThrow(`Illegal transition: ${status} -> ${action}`);
        expect(events).toEqual([]);
      }
    }
  });

  it.each([
    ["in_review", "approve"],
    ["approved", "save_inputs"],
    ["needs_info", "submit_manual"],
    ["processing", "abandon_processing"],
  ] as const)(
    "refuses %s -> %s when the audit write fails",
    async (status, action) => {
      const writer = {
        async write() {
          throw new Error("audit unavailable");
        },
      };

      await expect(
        transitionListing(status, action, auditContext, writer),
      ).rejects.toThrow("audit unavailable");
    },
  );
});
