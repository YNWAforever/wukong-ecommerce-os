import { describe, expect, it } from "vitest";

import fixture from "../fixtures/shopline-create-product.json" with { type: "json" };

import {
  evaluateDeliveryPolicy,
  hashCanonicalListing,
  projectToShopline,
  type DeliveryPolicyInput,
} from "./index.js";

const workspaceId = "workspace-1";
const draftId = "draft-1";
const versionId = "version-1";
const connectionId = "connection-1";
const imageUrls = ["https://cdn.example.test/assets/asset_demo_1.jpg"];

function input(overrides: Partial<DeliveryPolicyInput> = {}): DeliveryPolicyInput {
  return {
    method: "shopline_api",
    phase: "request",
    listing: {
      workspaceId,
      draftId,
      target: "shopline",
      status: "approved",
      activeVersion: { id: versionId, content: fixture.canonicalListing },
      flags: [],
    },
    imageUrls,
    connection: { id: connectionId, workspaceId, verified: true },
    job: null,
    ...overrides,
  };
}

describe("Shopline delivery policy", () => {
  it("returns an API plan bound to the active version, digest, payload, connection, and audit facts", () => {
    const result = evaluateDeliveryPolicy(input());

    expect(result).toMatchObject({
      kind: "ready",
      plan: {
        method: "shopline_api",
        workspaceId,
        draftId,
        versionId,
        payload: projectToShopline(fixture.canonicalListing, imageUrls),
        payloadDigest: hashCanonicalListing(fixture.canonicalListing),
        connectionId,
        idempotencyKey: `${workspaceId}:${versionId}:shopline:create`,
        auditFacts: {
          workspaceId,
          draftId,
          method: "shopline_api",
          phase: "request",
          versionId,
          payloadDigest: hashCanonicalListing(fixture.canonicalListing),
          connectionId,
          reason: "ready",
        },
      },
    });
  });

  it("returns a CSV plan from the same canonical projection and digest as the API plan", () => {
    const api = evaluateDeliveryPolicy(input());
    const csv = evaluateDeliveryPolicy(input({ method: "csv", connection: null }));

    expect(api.kind).toBe("ready");
    expect(csv.kind).toBe("ready");
    if (api.kind !== "ready" || csv.kind !== "ready") return;
    expect(csv.plan).toMatchObject({ method: "csv", versionId });
    expect(csv.plan.payload).toEqual(api.plan.payload);
    expect(csv.plan.payloadDigest).toBe(api.plan.payloadDigest);
    expect(csv.plan.connectionId).toBeUndefined();
    expect(csv.plan.idempotencyKey).toBeUndefined();
  });

  it.each([
    ["missing listing", input({ listing: null }), "not_found"],
    ["unsupported method", input({ method: "unsupported" as never }), "approval_required"],
    ["wrong target", input({ listing: { ...input().listing!, target: "other" } }), "approval_required"],
    ["missing active version", input({ listing: { ...input().listing!, activeVersion: null } }), "approval_required"],
    ["request non-approved status", input({ listing: { ...input().listing!, status: "review" } }), "approval_required"],
  ] as const)("returns %s as %s without throwing", (_case, policyInput, kind) => {
    expect(() => evaluateDeliveryPolicy(policyInput)).not.toThrow();
    expect(evaluateDeliveryPolicy(policyInput)).toMatchObject({ kind });
  });

  it("returns open blocking flags and permits resolved flags", () => {
    const blocking = {
      id: "flag-1",
      field: "description",
      rule: "unsupported_claim",
      severity: "blocking" as const,
      status: "open" as const,
      resolutionReason: null,
    };
    const blocked = evaluateDeliveryPolicy(input({ listing: { ...input().listing!, flags: [blocking] } }));
    const resolved = evaluateDeliveryPolicy(
      input({ listing: { ...input().listing!, flags: [{ ...blocking, status: "resolved", resolutionReason: "Reviewed and approved" }] } }),
    );

    expect(blocked).toMatchObject({ kind: "blocking_flags", flags: [blocking] });
    expect(resolved).toMatchObject({ kind: "ready" });
  });

  it.each([
    ["an unsupported-method outcome", input({ method: "unsupported" as never })],
    ["a wrong-target outcome", input({ listing: { ...input().listing!, target: "other" } })],
    ["a status outcome", input({ listing: { ...input().listing!, status: "review" } })],
    [
      "a blocking outcome",
      input({
        listing: {
          ...input().listing!,
          flags: [{ id: "flag-1", field: "description", rule: "unsupported_claim", severity: "blocking", status: "open", resolutionReason: null }],
        },
      }),
    ],
    [
      "a disconnected outcome",
      input({ connection: { id: connectionId, workspaceId: "other-workspace", verified: true } }),
    ],
  ] as const)("includes complete audit facts for %s", (_case, policyInput) => {
    const result = evaluateDeliveryPolicy(policyInput);

    expect(result).not.toHaveProperty("kind", "ready");
    expect(result.auditFacts).toMatchObject({
      workspaceId,
      draftId,
      method: policyInput.method,
      phase: "request",
      versionId,
      payloadDigest: hashCanonicalListing(fixture.canonicalListing),
      connectionId,
      reason: expect.any(String),
    });
  });

  it("returns structured validation issues instead of a plan when projection fails", () => {
    const result = evaluateDeliveryPolicy(
      input({ listing: { ...input().listing!, activeVersion: { id: versionId, content: { ...fixture.canonicalListing, priceHkd: null } as never } } }),
    );

    expect(result).toMatchObject({ kind: "validation_error" });
    expect(result).toHaveProperty("issues");
    expect(result).not.toHaveProperty("plan");
  });

  it.each([null, { id: connectionId, workspaceId, verified: false }])(
    "returns an explicit CSV fallback for an unavailable API connection",
    (connection) => {
      const result = evaluateDeliveryPolicy(input({ connection }));

      expect(result).toMatchObject({
        kind: "disconnected",
        csvFallback: { method: "csv", path: `/api/listings/${draftId}/deliver` },
        auditFacts: { reason: "disconnected" },
      });
    },
  );

  it("returns already_published before API connection eligibility", () => {
    const result = evaluateDeliveryPolicy(
      input({
        listing: { ...input().listing!, status: "published" },
        connection: { id: connectionId, workspaceId, verified: false },
      }),
    );

    expect(result).toMatchObject({
      kind: "already_published",
      auditFacts: { connectionId, reason: "already_published" },
    });
  });

  it("returns disconnected for a verified connection from another workspace", () => {
    const result = evaluateDeliveryPolicy(
      input({ connection: { id: connectionId, workspaceId: "other-workspace", verified: true } }),
    );

    expect(result).toMatchObject({
      kind: "disconnected",
      auditFacts: { connectionId, reason: "disconnected" },
    });
  });

  it.each(["approved", "publishing", "publish_failed"] as const)(
    "accepts %s worker re-entry only when the job version and digest bind the current plan",
    (status) => {
      const digest = hashCanonicalListing(fixture.canonicalListing);
      const result = evaluateDeliveryPolicy(
        input({
          phase: "worker",
          listing: { ...input().listing!, status },
          job: { id: "job-1", versionId, payloadDigest: digest, idempotencyKey: `${workspaceId}:${versionId}:shopline:create`, connectionId, status: "running" },
        }),
      );

      expect(result).toMatchObject({ kind: "ready", plan: { versionId, payloadDigest: digest } });
    },
  );

  it.each([
    [null, versionId, null],
    [{ id: "job-1", versionId: "version-0", payloadDigest: "current-digest", idempotencyKey: "key", connectionId, status: "running" }, "versionId", "version-0"],
    [{ id: "job-1", versionId, payloadDigest: null, idempotencyKey: "key", connectionId, status: "running" }, "payloadDigest", null],
    [{ id: "job-1", versionId, payloadDigest: "stale-digest", idempotencyKey: "key", connectionId, status: "running" }, "payloadDigest", "stale-digest"],
  ] as const)("returns stale_plan with expected and observed binding facts", (job, expectedKey, observed) => {
    const result = evaluateDeliveryPolicy(input({ phase: "worker", job }));

    expect(result).toMatchObject({
      kind: "stale_plan",
      expected: expect.any(Object),
      observed: expect.any(Object),
    });
    expect(JSON.stringify(result)).toContain(expectedKey);
    expect(JSON.stringify(result)).toContain(JSON.stringify(observed));
  });

  it("returns serializable outcomes with no executable or secret-bearing values", () => {
    const result = evaluateDeliveryPolicy(input());
    const serialized = JSON.parse(JSON.stringify(result)) as Record<string, unknown>;

    expect(serialized).toEqual(result);
    expect(JSON.stringify(result)).not.toContain("function");
  });
});
