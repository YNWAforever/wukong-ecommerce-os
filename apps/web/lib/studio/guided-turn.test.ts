import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeStudioUsage, type StudioModel } from "@wukong/ai";
import { isStudioAiEnabled, isStudioEnabled } from "../studio-flags";
import type { GuidedAction } from "./guided-contracts";
import { guidedScopeSchema } from "./guided-contracts";
import { gapReportPayloadSchema } from "./report-payload";
import { createStudioService } from "./turn-service";
import {
  sendMessageBodySchema,
  type SendMessageBody,
  type StudioSendResult,
} from "./contracts";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  reviewableContent,
  reviewSnapshot,
  openBlockingFlag,
  type FakeStudio,
} from "./test-fakes";

const ID = "11111111-1111-4111-8111-111111111111";
const VERSION = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const env = {
  CONVERSATION_STUDIO_ENABLED: "true",
  CONVERSATION_STUDIO_AI_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;
afterEach(() => vi.restoreAllMocks());
function message(id: string, guidedAction: GuidedAction): SendMessageBody {
  return {
    clientMessageId: id,
    text: `Review listing ${OTHER}; use the selected structured context.`,
    locale: "en",
    guidedAction,
  };
}
function source(
  kind: "gap_review" | "copy_proposal",
  result: StudioSendResult,
  fake: FakeStudio,
): GuidedAction {
  const ref = result.reply.outputs[0];
  if (!ref) throw new Error("Expected a persisted output");
  const version = fake.state.outputVersions.find(
    (value) =>
      value.outputId === ref.outputId && value.revision === ref.revision,
  );
  if (!version) throw new Error("Expected immutable version readback");
  return {
    kind,
    sourceOutputId: ref.outputId,
    sourceRevision: ref.revision,
    sourceDigest: version.contentDigest,
  };
}
function fixture(
  role: "operator" | "reviewer" | "viewer" = "reviewer",
  active = true,
) {
  const snapshots = {
    [ID]: reviewSnapshot({
      listingId: ID,
      versionId: VERSION,
      sequence: 1,
      content: active ? reviewableContent() : null,
    }),
  };
  const fake = createFakeStudio({
    snapshots,
    settings: {
      workspaceId: "ws_test",
      enabled: true,
      monthlyBudgetUsd: "10",
      runCeilingUsd: "2",
      ai: {
        provider: "opencode-go",
        model: "deepseek-v4.1-flash",
        pricingVersion: "opencode-go-2026-11",
        maxInputTokens: 1048576,
        inputUsdPerMillion: "0.3",
        outputUsdPerMillion: "1.2",
        maxOutputTokens: 4096,
      },
    },
  });
  const calls = { plan: 0, compose: 0, propose: 0 };
  const model: StudioModel = {
    async plan() {
      calls.plan++;
      throw new Error("Guided review does not plan");
    },
    async compose() {
      calls.compose++;
      throw new Error("Audit and gaps are deterministic");
    },
    async propose(input) {
      calls.propose++;
      return {
        proposal: {
          listingId: input.listing.listingId,
          activeVersionId: input.listing.activeVersionId,
          activeVersionSequence: input.listing.activeVersionSequence,
          fields: [
            {
              field: "description.en",
              current: "Tasting notes",
              proposed: "A clearer description for human review.",
              evidenceRefs: [`listing-copy:${ID}:v1`],
            },
          ],
          limitations: [],
        },
        usage: fakeStudioUsage({ estimatedCostUsd: 0.02 }),
      };
    },
  };
  const session = fakeSessionContext(role, { workspaceId: "ws_test" });
  const service = createStudioService({
    sessionContext: session.port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    isStudioEnabled,
    isStudioAiEnabled,
    env,
    now: () => new Date("2026-11-14T08:00:00Z"),
    createModel: () => model,
  });
  async function audit() {
    const thread = await service.createThread({ title: "Guided fixture" });
    const result = await service.sendMessage(
      thread.threadId,
      message("audit", {
        kind: "audit",
        listingId: ID,
        expectedActiveVersionId: active ? VERSION : null,
      }),
    );
    return { threadId: thread.threadId, result };
  }
  async function gaps() {
    const first = await audit();
    const result = await service.sendMessage(
      first.threadId,
      message("gaps", source("gap_review", first.result, fake)),
    );
    return { ...first, audit: first.result, result };
  }
  return { fake, snapshots, calls, model, service, audit, gaps };
}

describe("guided listing turns", () => {
  it("rejects caller-controlled scope, policy and unsupported guided actions", () => {
    const good = message("schema", {
      kind: "audit",
      listingId: ID,
      expectedActiveVersionId: VERSION,
    });
    expect(sendMessageBodySchema.safeParse(good).success).toBe(true);
    for (const candidate of [
      { ...good, workspaceId: "foreign" },
      { ...good, model: "other" },
      {
        ...good,
        guidedAction: { ...good.guidedAction, workspaceId: "foreign" },
      },
      { ...good, guidedAction: { kind: "publish", listingId: ID } },
      { ...good, guidedAction: { kind: "copy_proposal", listingId: ID } },
    ])
      expect(sendMessageBodySchema.safeParse(candidate).success).toBe(false);
  });

  it("enforces the operator role floor before preparing a guided turn", async () => {
    const f = fixture("viewer");
    const thread = await f.fake.repos.studio.threads.create({
      createdBy: "actor-other",
      title: "Read-only fixture",
    });
    await expect(
      f.service.sendMessage(
        thread.id,
        message("viewer", {
          kind: "audit",
          listingId: ID,
          expectedActiveVersionId: VERSION,
        }),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.fake.state.runs).toEqual([]);
    expect(f.calls.propose).toBe(0);
  });

  it("keeps missing selected-listing quality unknown instead of recording zero gaps", async () => {
    const f = fixture();
    const audit = await f.audit();
    const snapshot = f.snapshots[ID];
    vi.spyOn(f.fake.repos.listings, "getReviewSnapshot")
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(snapshot)
      .mockResolvedValueOnce(null);
    const gap = await f.service.sendMessage(
      audit.threadId,
      message("missing-quality", source("gap_review", audit.result, f.fake)),
    );
    const version = f.fake.state.outputVersions.find(
      (value) => value.outputId === gap.reply.outputs[0]!.outputId,
    )!;
    expect(
      gapReportPayloadSchema.parse(version.payload).listings?.[0]?.gaps,
    ).toBeNull();
    expect(
      guidedScopeSchema.parse(version.scope.guidedReview).quality,
    ).toBeNull();
    await expect(
      f.service.sendMessage(
        audit.threadId,
        message("copy", source("copy_proposal", gap, f.fake)),
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "guided_quality_unavailable",
    });
    expect(f.calls.propose).toBe(0);
    expect(f.fake.state.budgets).toEqual([]);
  });

  it("persists audit and selected gaps without a model, then uses exactly one copy proposal call", async () => {
    const f = fixture();
    const original = structuredClone(f.snapshots[ID]);
    const gap = await f.gaps();
    expect(f.calls).toEqual({ plan: 0, compose: 0, propose: 0 });
    expect(f.fake.state.budgets).toEqual([]);
    const gapVersion = f.fake.state.outputVersions.find(
      (value) => value.outputId === gap.result.reply.outputs[0]!.outputId,
    )!;
    const report = gapReportPayloadSchema.parse(gapVersion.payload);
    expect(report.scope).toMatchObject({
      mode: "selected",
      listingIds: [ID],
      truncated: false,
    });
    expect(report.listings).toHaveLength(1);
    expect(report.listings?.[0]).toMatchObject({
      listingId: ID,
      activeVersion: { versionId: VERSION, sequence: 1 },
      gaps: [],
    });
    expect(
      guidedScopeSchema.parse(gapVersion.scope.guidedReview),
    ).toMatchObject({
      stage: "gap_review",
      listing: { listingId: ID },
      quality: {
        assessmentVersion: expect.any(String),
        gapsDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      },
    });
    const body = message("copy", source("copy_proposal", gap.result, f.fake));
    const copy = await f.service.sendMessage(gap.threadId, body);
    expect(copy.reply.outputs).toHaveLength(1);
    expect(f.calls).toEqual({ plan: 0, compose: 0, propose: 1 });
    expect(f.fake.state.budgets).toHaveLength(1);
    expect(f.snapshots[ID]).toEqual(original);
    const proposal = await f.service.getOutput(copy.reply.outputs[0]!.outputId);
    expect(proposal.versions[0]?.payload.listingId).toBe(ID);
    expect(proposal.output.freshness).toBe("current");
    f.snapshots[ID] = reviewSnapshot({
      listingId: ID,
      versionId: OTHER,
      sequence: 2,
      content: reviewableContent(),
    });
    expect((await f.service.sendMessage(gap.threadId, body)).replayed).toBe(
      true,
    );
    expect(f.calls.propose).toBe(1);
    expect(
      (await f.service.getOutput(copy.reply.outputs[0]!.outputId)).output
        .freshness,
    ).toBe("stale");
  });

  it("deduplicates an in-flight paid step before a second reservation or model call", async () => {
    const f = fixture();
    const gap = await f.gaps();
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = f.model.propose!.bind(f.model);
    const propose = vi
      .spyOn(f.model, "propose")
      .mockImplementation(async (input) => {
        entered();
        await gate;
        return original(input);
      });
    const body = message(
      "concurrent-copy",
      source("copy_proposal", gap.result, f.fake),
    );
    const first = f.service.sendMessage(gap.threadId, body);
    await started;
    try {
      const resumed = await f.service.getThread(gap.threadId);
      expect(resumed.latestGuidedAttempt).toMatchObject({
        clientMessageId: "concurrent-copy",
        status: "running",
      });
      await expect(
        f.service.sendMessage(gap.threadId, body),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.fake.state.budgets).toHaveLength(1);
      expect(propose).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    expect((await first).reply.outputs).toHaveLength(1);
    expect((await f.service.sendMessage(gap.threadId, body)).replayed).toBe(
      true,
    );
    expect(propose).toHaveBeenCalledTimes(1);
  });

  it("recovers the original artifact when model work succeeds but the assistant reply cannot be saved", async () => {
    const f = fixture();
    const gap = await f.gaps();
    const append = f.fake.repos.studio.messages.append.bind(
      f.fake.repos.studio.messages,
    );
    vi.spyOn(f.fake.repos.studio.messages, "append").mockImplementation(
      async (input) => {
        if (input.role === "assistant")
          throw new Error("Synthetic reply persistence failure");
        return append(input);
      },
    );
    const propose = vi.spyOn(f.model, "propose");
    await expect(
      f.service.sendMessage(
        gap.threadId,
        message("reply-lost-copy", source("copy_proposal", gap.result, f.fake)),
      ),
    ).rejects.toThrow();
    const resumed = await f.service.getThread(gap.threadId);
    expect(resumed.latestGuidedAttempt).toMatchObject({
      clientMessageId: "reply-lost-copy",
      status: "failed",
      reservationState: "settled",
      artifacts: [
        {
          outputId: f.fake.state.outputs.at(-1)!.id,
          revision: 1,
          contentDigest: f.fake.state.outputVersions.at(-1)!.contentDigest,
        },
      ],
    });
    expect(propose).toHaveBeenCalledTimes(1);
  });
  it("exposes an uncertain hold on a completed partial reply without resubmitting it", async () => {
    const f = fixture();
    const gap = await f.gaps();
    const propose = vi
      .spyOn(f.model, "propose")
      .mockRejectedValue(new Error("Synthetic uncertain response"));
    const result = await f.service.sendMessage(
      gap.threadId,
      message("uncertain-copy", source("copy_proposal", gap.result, f.fake)),
    );
    expect(result.reply.outputs).toHaveLength(0);
    const resumed = await f.service.getThread(gap.threadId);
    expect(resumed.latestGuidedAttempt).toMatchObject({
      clientMessageId: "uncertain-copy",
      status: "succeeded",
      reservationState: "uncertain",
    });
    expect(propose).toHaveBeenCalledTimes(1);
  });
  it("blocks sign-off when quality changes behind the same canonical version", async () => {
    const f = fixture();
    const gap = await f.gaps();
    const copy = await f.service.sendMessage(
      gap.threadId,
      message("copy-signoff", source("copy_proposal", gap.result, f.fake)),
    );
    const id = copy.reply.outputs[0]!.outputId;
    const detail = await f.service.getOutput(id);
    const version = detail.versions[0]!;
    const pin = {
      expectedRevision: version.revision,
      expectedDigest: version.contentDigest,
    };
    await f.service.setOutputStatus(id, "save", pin);
    f.snapshots[ID] = reviewSnapshot({
      listingId: ID,
      versionId: VERSION,
      sequence: 1,
      content: reviewableContent(),
      flags: [openBlockingFlag()],
    });
    expect((await f.service.getOutput(id)).output.freshness).toBe("stale");
    await expect(
      f.service.setOutputStatus(id, "sign_off", pin),
    ).rejects.toMatchObject({ status: 409, code: "proposal_outdated" });
    expect(
      f.fake.state.audits.filter(
        (event) => event.action === "studio.output.signed_off",
      ),
    ).toHaveLength(0);
  });

  it("rejects changed context under an accepted client id", async () => {
    const f = fixture();
    const a = await f.audit();
    await expect(
      f.service.sendMessage(
        a.threadId,
        message("audit", {
          kind: "audit",
          listingId: OTHER,
          expectedActiveVersionId: VERSION,
        }),
      ),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    expect(f.fake.state.runs).toHaveLength(1);
    expect(f.calls.propose).toBe(0);
  });

  it("refuses removal of guided context when retrying an accepted message id", async () => {
    const f = fixture();
    const a = await f.audit();
    await expect(
      f.service.sendMessage(a.threadId, {
        clientMessageId: "audit",
        text: message("audit", {
          kind: "audit",
          listingId: ID,
          expectedActiveVersionId: VERSION,
        }).text,
        locale: "en",
        skillKey: "merchant.audit",
      }),
    ).rejects.toMatchObject({ status: 409, code: "idempotency_conflict" });
    expect(f.fake.state.runs).toHaveLength(1);
  });

  it("honors private conversation visibility before looking up a source", async () => {
    const f = fixture("operator");
    const thread = await f.fake.repos.studio.threads.create({
      createdBy: "another-actor",
      title: "Private fixture",
      visibility: "private",
    });
    const lookup = vi.spyOn(f.fake.repos.studio.outputs, "get");
    await expect(
      f.service.sendMessage(
        thread.id,
        message("private", {
          kind: "gap_review",
          sourceOutputId: OTHER,
          sourceRevision: 1,
          sourceDigest: "a".repeat(64),
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(lookup).not.toHaveBeenCalled();
    expect(f.calls.propose).toBe(0);
  });

  it("does not reroute from text or accept a conflicting skill", async () => {
    const f = fixture();
    const t = await f.service.createThread({ title: "Mismatch" });
    await expect(
      f.service.sendMessage(t.threadId, {
        ...message("bad", {
          kind: "audit",
          listingId: ID,
          expectedActiveVersionId: VERSION,
        }),
        skillKey: "listing.copy_proposal",
      }),
    ).rejects.toMatchObject({ status: 400, code: "guided_skill_mismatch" });
    expect(f.fake.state.runs).toEqual([]);
  });

  it("rejects stale listing, parent revision, digest and wrong-step references before model admission", async () => {
    const f = fixture();
    const a = await f.audit();
    const good = source("gap_review", a.result, f.fake);
    if (good.kind === "audit") throw new Error("Expected parent");
    for (const [index, action] of [
      { ...good, sourceRevision: 2 },
      { ...good, sourceDigest: "b".repeat(64) },
      { ...good, kind: "copy_proposal" as const },
    ].entries())
      await expect(
        f.service.sendMessage(a.threadId, message(`bad-${index}`, action)),
      ).rejects.toMatchObject({ status: 409 });
    f.snapshots[ID] = reviewSnapshot({
      listingId: ID,
      versionId: OTHER,
      sequence: 2,
      content: reviewableContent(),
    });
    await expect(
      f.service.sendMessage(a.threadId, message("stale", good)),
    ).rejects.toMatchObject({ status: 409, code: "guided_source_stale" });
    expect(f.calls.propose).toBe(0);
    expect(f.fake.state.budgets).toEqual([]);
  });

  it("does not move an artifact into another conversation", async () => {
    const f = fixture();
    const a = await f.audit();
    const t = await f.service.createThread({ title: "Other conversation" });
    const readVersion = vi.spyOn(f.fake.repos.studio.outputs, "getVersion");
    await expect(
      f.service.sendMessage(
        t.threadId,
        message("foreign-thread", source("gap_review", a.result, f.fake)),
      ),
    ).rejects.toMatchObject({ status: 404 });
    expect(readVersion).not.toHaveBeenCalled();
    expect(f.fake.state.runs).toHaveLength(1);
  });

  it("requires a new gap review when flags change without a new listing version", async () => {
    const f = fixture();
    const gap = await f.gaps();
    f.snapshots[ID] = reviewSnapshot({
      listingId: ID,
      versionId: VERSION,
      sequence: 1,
      content: reviewableContent(),
      flags: [openBlockingFlag()],
    });
    await expect(
      f.service.sendMessage(
        gap.threadId,
        message("copy", source("copy_proposal", gap.result, f.fake)),
      ),
    ).rejects.toMatchObject({ status: 409, code: "guided_source_stale" });
    expect(f.calls.propose).toBe(0);
    expect(f.fake.state.budgets).toEqual([]);
  });

  it("keeps a missing active version explicit and blocks copy generation", async () => {
    const f = fixture("reviewer", false);
    const gap = await f.gaps();
    const version = f.fake.state.outputVersions.find(
      (value) => value.outputId === gap.result.reply.outputs[0]!.outputId,
    )!;
    expect(
      gapReportPayloadSchema.parse(version.payload).listings?.[0],
    ).toMatchObject({
      activeVersion: null,
      gaps: [{ code: "no_active_version", blocking: true }],
    });
    await expect(
      f.service.sendMessage(
        gap.threadId,
        message("copy", source("copy_proposal", gap.result, f.fake)),
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "guided_listing_unavailable",
    });
    expect(f.calls.propose).toBe(0);
  });
});
