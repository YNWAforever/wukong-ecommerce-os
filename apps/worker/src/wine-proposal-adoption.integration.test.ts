import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  emptyWorkingListing,
  wineEnrichmentPolicySchema,
  wineExecutionSnapshotSchema,
} from "@wukong/core";
import {
  adoptWineProposal,
  readAdoptedWineDependencies,
  buildWineCopySnapshot,
  resolveWineGenerationOwnership,
} from "@wukong/db";
import { db, admin, ready } from "./wine-candidate-projection.fixture.js";
async function proposed(
  mutate?: Parameters<typeof ready>[1],
  sourceAgeDays = 0,
) {
  const first = await ready(undefined, undefined, undefined, sourceAgeDays);
  const initial = await first.store.commitCandidate(first.context);
  if (initial.status !== "completed" || !initial.versionId)
    throw Error("initial version missing");
  const next = await ready(
    emptyWorkingListing(),
    mutate,
    undefined,
    sourceAgeDays,
    false,
    { workspaceId: first.job.workspaceId, listingId: first.run.listingId },
  );
  expect(await next.store.commitCandidate(next.context)).toMatchObject({
    outcome: "proposed",
    versionId: null,
  });
  const request = {
    workspaceId: next.job.workspaceId,
    listingId: next.run.listingId,
    runId: next.run.id,
    actorId: "tester",
    expectedInputRevision: next.run.inputRevision,
    baseVersionId: next.run.baseVersionId!,
    operationKey: randomUUID(),
    selectedPaths: ["title.en"],
  };
  return { first, next, request, initial };
}
async function counts(workspaceId: string) {
  return (
    await admin`select (select count(*) from listing_versions where workspace_id=${workspaceId}) versions,(select count(*) from wine_section_snapshots where workspace_id=${workspaceId}) sections,(select count(*) from audit_events where workspace_id=${workspaceId}) audits,(select count(*) from ai_runs where workspace_id=${workspaceId}) calls,(select count(*) from ai_budget_reservations where workspace_id=${workspaceId}) holds`
  )[0];
}
it("partial research adoption retains disjoint original claims and builds actual copy dependencies", async () => {
  const f = await proposed();
  const before = await db.forWorkspace(f.request.workspaceId, (r) =>
    r.wineEnrichment.readStage(f.next.run.id, "commit_candidate"),
  );
  const version = await db.forWorkspace(f.request.workspaceId, (r) =>
    adoptWineProposal(r, f.request),
  );
  await db.forWorkspace(f.request.workspaceId, async (r) => {
    const dependencies = await readAdoptedWineDependencies(r, {
      ...f.request,
      versionId: version.versionId,
      inputRevision: f.request.expectedInputRevision,
    });
    expect(dependencies.status).toBe("available");
    if (dependencies.status !== "available") throw Error(dependencies.code);
    expect(dependencies.supports).toContainEqual(
      expect.objectContaining({
        path: "title.en",
        originRunId: f.next.run.id,
        claimId: f.next.claim.id,
        valid: true,
      }),
    );
    expect(dependencies.supports).toContainEqual(
      expect.objectContaining({
        path: "sections.introduction.en",
        originRunId: f.first.run.id,
        claimId: f.first.claim.id,
        valid: true,
      }),
    );
    const input = (await r.listingInputs.getCurrent(f.request.listingId))!,
      row = (await r.wineEnrichment.readVersionOrigin(
        f.request.listingId,
        version.versionId,
      ))!;
    const ownership = resolveWineGenerationOwnership(
      input,
      input.workingContent,
      row.content,
      {
        workspaceId: f.request.workspaceId,
        listingId: f.request.listingId,
        operationId: randomUUID(),
        inputRevision: input.revision,
        baseVersionId: version.versionId,
      },
    );
    const built = buildWineCopySnapshot({
      adopted: dependencies,
      input,
      ownership,
      mode: "copy",
      section: null,
      policy: wineEnrichmentPolicySchema.parse(
        f.next.run.execution.wineEnrichment,
      ),
      model: wineExecutionSnapshotSchema.parse(f.next.run.execution.wineGo),
    });
    expect(new Set(built.snapshot.claims.map((c) => c.originRunId))).toEqual(
      new Set([f.first.run.id, f.next.run.id]),
    );
    expect(
      await r.wineEnrichment.readStage(f.next.run.id, "commit_candidate"),
    ).toEqual(before);
  });
});
it.each(["same", "different"])(
  "concurrent %s request replay creates one immutable adoption",
  async (kind) => {
    const f = await proposed(),
      before = await counts(f.request.workspaceId);
    const other = {
      ...f.request,
      selectedPaths:
        kind === "same" ? [...f.request.selectedPaths] : ["title.zh-Hant"],
    };
    const results = await Promise.allSettled(
      [f.request, other].map((request) =>
        db.forWorkspace(request.workspaceId, (r) =>
          adoptWineProposal(r, request),
        ),
      ),
    );
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(
      kind === "same" ? 2 : 1,
    );
    if (kind === "different")
      expect(
        (results.find((x) => x.status === "rejected") as PromiseRejectedResult)
          .reason.message,
      ).toBe("idempotency_conflict");
    else
      expect((results[0] as PromiseFulfilledResult<unknown>).value).toEqual(
        (results[1] as PromiseFulfilledResult<unknown>).value,
      );
    const after = await counts(f.request.workspaceId);
    expect(Number(after.versions)).toBe(Number(before.versions) + 1);
    expect(Number(after.sections)).toBe(Number(before.sections) + 1);
    expect(after.calls).toBe(before.calls);
    expect(after.holds).toBe(before.holds);
  },
);
it("downstream reader rejection rolls back version snapshot audit and activation even if caller catches", async () => {
  const f = await proposed(),
    before = await counts(f.request.workspaceId);
  await db.forWorkspace(f.request.workspaceId, async (r) => {
    const altered = {
      ...r,
      wineEnrichment: {
        ...r.wineEnrichment,
        readVersionOrigin: async (listingId: string, versionId: string) => {
          const row = await r.wineEnrichment.readVersionOrigin(
            listingId,
            versionId,
          );
          return row?.adoption ? { ...row, createdBy: "forged" } : row;
        },
      },
    };
    await expect(adoptWineProposal(altered, f.request)).rejects.toThrow(
      "adopted_proposal_binding_invalid",
    );
  });
  expect(await counts(f.request.workspaceId)).toEqual(before);
  expect(
    (
      await db.forWorkspace(f.request.workspaceId, (r) =>
        r.listings.getById(f.request.listingId),
      )
    )?.activeVersionId,
  ).toBe(f.request.baseVersionId);
});
it.each([
  "revision",
  "base",
  "foreign",
  "price",
  "locked",
  "identity",
  "client-content",
])("rejects %s without writes", async (kind) => {
  const f = await proposed();
  const before = await counts(f.request.workspaceId);
  let request: any = { ...f.request };
  if (kind === "revision") request.expectedInputRevision++;
  if (kind === "base") request.baseVersionId = randomUUID();
  if (kind === "foreign") request.workspaceId = "foreign";
  if (kind === "price") request.selectedPaths = ["priceHkd"];
  if (kind === "identity") request.selectedPaths = ["wineIdentitySelection"];
  if (kind === "client-content") request.content = { producer: "Forged" };
  if (kind === "locked") {
    await db.forWorkspace(f.request.workspaceId, (r) =>
      r.listingInputs.save(
        {
          listingId: f.request.listingId,
          actorId: "tester",
          expectedInputRevision: f.request.expectedInputRevision,
          baseVersionId: f.request.baseVersionId,
          operationKey: randomUUID(),
          requestDigest: randomUUID(),
          changes: [
            {
              field: "title.en",
              value: "Merchant title",
              state: "manual",
              locked: true,
            },
          ],
        },
        {
          workspaceId: f.request.workspaceId,
          actorId: "tester",
          entityId: f.request.listingId,
        },
        r.audit,
      ),
    );
  }
  const snapshot = await counts(f.request.workspaceId);
  await expect(
    db.forWorkspace(f.request.workspaceId, (r) =>
      adoptWineProposal(r, request),
    ),
  ).rejects.toThrow();
  expect(await counts(f.request.workspaceId)).toEqual(
    kind === "locked" ? snapshot : before,
  );
});
it("terminal proposal may be adopted after compute deadline while evidence remains current", async () => {
  const f = await proposed();
  const now = new Date(
    Date.parse(f.next.run.acceptedAt) + 16 * 60_000,
  ).toISOString();
  const result = await db.forWorkspace(f.request.workspaceId, (r) =>
    adoptWineProposal(
      {
        ...r,
        pipelineRuns: {
          ...r.pipelineRuns,
          acceptanceTimestamp: async () => now,
        },
      },
      f.request,
    ),
  );
  expect(result.versionId).not.toBe(f.request.baseVersionId);
});
it("expired source rejects new adoption without refreshing capture time", async () => {
  const f = await proposed(undefined, 1),
    before = await counts(f.request.workspaceId);
  await expect(
    db.forWorkspace(f.request.workspaceId, (r) =>
      adoptWineProposal(
        {
          ...r,
          pipelineRuns: {
            ...r.pipelineRuns,
            acceptanceTimestamp: async () =>
              new Date(
                Date.parse(f.next.run.acceptedAt) + 8 * 86400000,
              ).toISOString(),
          },
        },
        f.request,
      ),
    ),
  ).rejects.toThrow("evidence_refresh_required");
  expect(await counts(f.request.workspaceId)).toEqual(before);
});
it("replay after a later manual edit returns original version without reactivation", async () => {
  const f = await proposed();
  const saved = await db.forWorkspace(f.request.workspaceId, (r) =>
    adoptWineProposal(r, f.request),
  );
  await db.forWorkspace(f.request.workspaceId, (r) =>
    r.listingInputs.save(
      {
        listingId: f.request.listingId,
        actorId: "tester",
        expectedInputRevision: f.request.expectedInputRevision,
        baseVersionId: saved.versionId,
        operationKey: randomUUID(),
        requestDigest: randomUUID(),
        changes: [{ field: "stockQuantity", value: 5, state: "manual" }],
      },
      {
        workspaceId: f.request.workspaceId,
        actorId: "tester",
        entityId: f.request.listingId,
      },
      r.audit,
    ),
  );
  const before = await counts(f.request.workspaceId);
  expect(
    await db.forWorkspace(f.request.workspaceId, (r) =>
      adoptWineProposal(r, f.request),
    ),
  ).toEqual(saved);
  expect(await counts(f.request.workspaceId)).toEqual(before);
});

it.each(["pipeline-key", "actor", "request", "proposal-digest", "selection"])(
  "historical reader rejects altered immutable %s proof",
  async (kind) => {
    const f = await proposed();
    const saved = await db.forWorkspace(f.request.workspaceId, (r) =>
      adoptWineProposal(r, f.request),
    );
    const result = await db.forWorkspace(f.request.workspaceId, (r) =>
      readAdoptedWineDependencies(
        {
          ...r,
          wineEnrichment: {
            ...r.wineEnrichment,
            readVersionOrigin: async (listingId, versionId) => {
              const row = await r.wineEnrichment.readVersionOrigin(
                listingId,
                versionId,
              );
              if (!row?.adoption) return row;
              if (kind === "pipeline-key")
                return {
                  ...row,
                  pipelineIdempotencyKey: f.request.operationKey,
                };
              if (kind === "actor") return { ...row, createdBy: "forged" };
              return {
                ...row,
                adoption: {
                  ...row.adoption,
                  ...(kind === "request"
                    ? { requestDigest: "0".repeat(64) }
                    : kind === "proposal-digest"
                      ? { proposalContentDigest: "0".repeat(64) }
                      : { selectedPaths: ["title.zh-Hant"] }),
                },
              };
            },
          },
        },
        {
          ...f.request,
          versionId: saved.versionId,
          inputRevision: f.request.expectedInputRevision,
        },
      ),
    );
    expect(result.status).toBe("unavailable");
  },
);
it("same operation key with changed actor rejects before replay", async () => {
  const f = await proposed();
  await db.forWorkspace(f.request.workspaceId, (r) =>
    adoptWineProposal(r, f.request),
  );
  const before = await counts(f.request.workspaceId);
  await expect(
    db.forWorkspace(f.request.workspaceId, (r) =>
      adoptWineProposal(r, { ...f.request, actorId: "other" }),
    ),
  ).rejects.toThrow("idempotency_conflict");
  expect(await counts(f.request.workspaceId)).toEqual(before);
});
it.each([0, 1])(
  "distinct original namespaces sharing a claim ID fail closed (web=%s)",
  async (sourceAgeDays) => {
    const first = await ready();
    const initial = await first.store.commitCandidate(first.context);
    expect(initial).toMatchObject({ outcome: "complete" });
    const next = await ready(
      emptyWorkingListing(),
      (result) => {
        if (result.stage === "verification" && result.state === "succeeded")
          result.claims[0]!.id = first.claim.id;
        return result;
      },
      undefined,
      sourceAgeDays,
      false,
      { workspaceId: first.job.workspaceId, listingId: first.run.listingId },
    );
    expect(await next.store.commitCandidate(next.context)).toMatchObject({
      outcome: "proposed",
    });
    const request = {
      workspaceId: next.job.workspaceId,
      listingId: next.run.listingId,
      runId: next.run.id,
      actorId: "tester",
      expectedInputRevision: next.run.inputRevision,
      baseVersionId: next.run.baseVersionId!,
      operationKey: randomUUID(),
      selectedPaths: ["title.en"],
    };
    const before = await counts(request.workspaceId);
    await expect(
      db.forWorkspace(request.workspaceId, (r) =>
        adoptWineProposal(r, request),
      ),
    ).rejects.toThrow(
      sourceAgeDays
        ? "proposal_support_incompatible"
        : "proposal_claim_origin_collision",
    );
    expect(await counts(request.workspaceId)).toEqual(before);
  },
);

it("current registry revocation rejects terminal adoption", async () => {
  const f = await proposed(undefined, 1),
    reviewer = randomUUID();
  await admin`insert into users(id,email) values(${reviewer},${reviewer + "@example.test"})`;
  await admin`insert into memberships(workspace_id,user_id,role) values(${f.request.workspaceId},${reviewer},'reviewer')`;
  await db.forWorkspace(f.request.workspaceId, (r) =>
    r.wineEnrichment.recordReviewedAuthority(reviewer, {
      schemaVersion: 1,
      domain: "wine.test",
      subject: { kind: "producer", name: "Fixture Estate" },
      proofUrl: "https://wine.test/about",
      proofDigest: "a".repeat(64),
      verifiedAt: f.next.run.acceptedAt,
      expiresAt: new Date(
        Date.parse(f.next.run.acceptedAt) + 86400000,
      ).toISOString(),
      revokedAt: f.next.run.acceptedAt,
      verifierId: reviewer,
    }),
  );
  const before = await counts(f.request.workspaceId);
  await expect(
    db.forWorkspace(f.request.workspaceId, (r) =>
      adoptWineProposal(r, f.request),
    ),
  ).rejects.toThrow();
  expect(await counts(f.request.workspaceId)).toEqual(before);
});

it.each(["actorId", "proposalRunId", "operationKey", "baseVersionId"])(
  "replay rejects mismatched immutable %s even with copied request digest",
  async (field) => {
    const f = await proposed();
    await db.forWorkspace(f.request.workspaceId, (r) =>
      adoptWineProposal(r, f.request),
    );
    await expect(
      db.forWorkspace(f.request.workspaceId, (r) =>
        adoptWineProposal(
          {
            ...r,
            wineEnrichment: {
              ...r.wineEnrichment,
              readAdoptionByOperationKey: async (listingId, key) => {
                const row = await r.wineEnrichment.readAdoptionByOperationKey(
                  listingId,
                  key,
                );
                return row
                  ? {
                      ...row,
                      adoption: { ...row.adoption!, [field]: randomUUID() },
                    }
                  : row;
              },
            },
          },
          f.request,
        ),
      ),
    ).rejects.toThrow("idempotency_conflict");
  },
);

it("existing generated pipeline key cannot be reused as human adoption key", async () => {
  const f = await proposed(),
    before = await counts(f.request.workspaceId);
  const collision = await db.forWorkspace(f.request.workspaceId, (r) =>
    r.wineEnrichment.readAdoptionByOperationKey(
      f.request.listingId,
      f.first.run.idempotencyKey,
    ),
  );
  expect(collision?.versionId).toBe(f.initial.versionId);
  expect(collision?.adoption).toBeUndefined();
  await expect(
    db.forWorkspace(f.request.workspaceId, (r) =>
      adoptWineProposal(r, {
        ...f.request,
        operationKey: f.first.run.idempotencyKey,
      }),
    ),
  ).rejects.toThrow("Invalid UUID");
  expect(await counts(f.request.workspaceId)).toEqual(before);
});
it("ambiguous persisted adoption keys reject instead of choosing a first row", async () => {
  const f = await proposed();
  const saved = await db.forWorkspace(f.request.workspaceId, (r) =>
    adoptWineProposal(r, f.request),
  );
  // Deliberate corrupt repository fixture: duplicate immutable proof attached to another real version.
  await db.forWorkspace(f.request.workspaceId, async (r) => {
    await r.listings.lockReviewState(f.request.listingId);
    const row = (await r.wineEnrichment.readVersionOrigin(
      f.request.listingId,
      saved.versionId,
    ))!;
    const version = await r.listings.appendVersion(
      f.request.listingId,
      row.content,
      {
        workspaceId: f.request.workspaceId,
        actorId: "tester",
        entityId: f.request.listingId,
      },
      r.audit,
    );
    await r.wineEnrichment.saveSections({
      runId: f.next.run.id,
      listingId: f.request.listingId,
      versionId: version.id,
      content: row.sections!,
      adoption: row.adoption,
    });
  });
  const before = await counts(f.request.workspaceId);
  await expect(
    db.forWorkspace(f.request.workspaceId, (r) =>
      adoptWineProposal(r, f.request),
    ),
  ).rejects.toThrow("idempotency_conflict");
  expect(await counts(f.request.workspaceId)).toEqual(before);
});
