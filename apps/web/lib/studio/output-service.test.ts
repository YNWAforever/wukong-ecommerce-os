import { describe, expect, it } from "vitest";

import {
  canonicalJson,
  copyProposalDigest,
  createCopyProposalOutput,
  createReportOutput,
  type CopyProposalPayload,
  type StudioOutputDeps,
} from "./output-service.js";
import { createFakeStudio, fakeGetDatabase } from "./test-fakes.js";

const NOW = new Date("2026-11-08T10:00:00.000Z");
const WORKSPACE = "ws_test";

const payload: CopyProposalPayload = {
  listingId: "11111111-1111-4111-8111-111111111111",
  activeVersionId: "22222222-2222-4222-8222-222222222222",
  activeVersionSequence: 2,
  fields: [
    {
      field: "description.en",
      current: "Old copy.",
      proposed: "Bright fruit and a long finish.",
      evidenceRefs: ["listing-copy:11111111-1111-4111-8111-111111111111:v2"],
    },
  ],
  limitations: [],
  asOf: NOW.toISOString(),
};

function fixture() {
  const fake = createFakeStudio({});
  const database = fakeGetDatabase(fake.repos, fake.state.workspaceCalls);
  const deps = {
    getDatabase: database,
  } as unknown as StudioOutputDeps;
  return { fake, deps };
}

describe("canonicalJson and copyProposalDigest", () => {
  it("are stable across object-key order and produce a sha256 digest", () => {
    const a = { b: 1, a: [2, { d: 3, c: 4 }] };
    const b = { a: [2, { c: 4, d: 3 }], b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(copyProposalDigest(payload)).toMatch(/^[a-f0-9]{64}$/);
    expect(copyProposalDigest(payload)).toBe(
      copyProposalDigest({ ...payload, limitations: [] }),
    );
  });
});

describe("createCopyProposalOutput", () => {
  it("persists an immutable version, reads it back and audits the proposal", async () => {
    const { fake, deps } = fixture();
    const created = await createCopyProposalOutput(
      deps,
      {
        workspaceId: WORKSPACE,
        actorId: "actor_ops",
        threadId: "33333333-3333-4333-8333-333333333333",
        runId: "44444444-4444-4444-8444-444444444444",
        title: "Copy proposal test",
        payload,
        asOf: NOW,
      },
    );
    expect(created.revision).toBe(1);
    expect(created.contentDigest).toBe(copyProposalDigest(payload));
    expect(fake.state.outputs).toHaveLength(1);
    expect(fake.state.outputs[0]).toMatchObject({
      kind: "copy_proposal",
      status: "draft",
      currentVersion: 1,
      title: "Copy proposal test",
    });
    expect(fake.state.outputVersions).toHaveLength(1);
    expect(fake.state.outputVersions[0]).toMatchObject({
      revision: 1,
      contentDigest: created.contentDigest,
      scope: {
        listingId: payload.listingId,
        activeVersionId: payload.activeVersionId,
        activeVersionSequence: 2,
      },
    });
    expect(fake.state.writes).toEqual(
      expect.arrayContaining([
        "outputs.create",
        "outputs.addVersion",
        "outputs.get",
        "outputs.versions",
      ]),
    );
    const audit = fake.state.audits.find(
      (event) => event.action === "studio.output.proposed",
    );
    expect(audit?.metadata).toMatchObject({
      kind: "copy_proposal",
      revision: 1,
      contentDigest: created.contentDigest,
      listingId: payload.listingId,
      fieldCount: 1,
    });
  });
});

describe("createReportOutput", () => {
  it("persists a digest-verified report version and audits the artifact", async () => {
    const { fake, deps } = fixture();
    const created = await createReportOutput(deps, {
      workspaceId: WORKSPACE,
      actorId: "actor_ops",
      threadId: "33333333-3333-4333-8333-333333333333",
      runId: "44444444-4444-4444-8444-444444444444",
      kind: "merchant_audit",
      title: "Merchant audit",
      payload: { schemaVersion: "wukong-merchant-audit/v1", listings: [] },
      asOf: NOW,
    });
    expect(created.revision).toBe(1);
    expect(created.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(fake.state.outputs[0]).toMatchObject({
      kind: "merchant_audit",
      status: "draft",
      currentVersion: 1,
    });
    expect(fake.state.outputVersions[0]).toMatchObject({
      revision: 1,
      contentDigest: created.contentDigest,
      scope: { workspaceScoped: true },
    });
    const audit = fake.state.audits.find(
      (event) => event.action === "studio.output.proposed",
    );
    expect(audit?.metadata).toMatchObject({
      kind: "merchant_audit",
      revision: 1,
      contentDigest: created.contentDigest,
    });
  });
});
