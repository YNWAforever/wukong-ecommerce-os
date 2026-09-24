import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  emptyWorkingListing,
  wineEnrichmentPolicySchema,
  wineExecutionSnapshotSchema,
} from "@wukong/core";
import * as dbApi from "@wukong/db";
import {
  db,
  admin,
  ready,
} from "../../../../worker/src/wine-candidate-projection.fixture";
import { createWineProposalHandlers } from "../../../lib/wine-proposal-route";
import { readWineProgress } from "../../../lib/wine-progress";
async function fixture(sourceAgeDays = 0) {
  const first = await ready(undefined, undefined, undefined, sourceAgeDays);
  await first.store.commitCandidate(first.context);
  const next = await ready(
    emptyWorkingListing(),
    undefined,
    undefined,
    sourceAgeDays,
    false,
    { workspaceId: first.job.workspaceId, listingId: first.run.listingId },
  );
  await next.store.commitCandidate(next.context);
  const handlers = createWineProposalHandlers({
    sessionContext: {
      resolve: async () => ({
        workspaceId: next.job.workspaceId,
        actorId: "tester",
        role: "operator",
      }),
    },
    getDatabase: () => db,
  });
  const context = {
    params: Promise.resolve({ id: next.run.listingId, runId: next.run.id }),
  };
  const body = {
    expectedInputRevision: next.run.inputRevision,
    baseVersionId: next.run.baseVersionId!,
    selectedPaths: ["title.en"],
  };
  const key = randomUUID();
  const post = (value: unknown = body, operationKey = key) =>
    handlers.POST(
      new Request("http://localhost/adopt", {
        method: "POST",
        headers: { "Idempotency-Key": operationKey },
        body: JSON.stringify(value),
      }),
      context,
    );
  const get = () =>
    handlers.GET(new Request("http://localhost/proposal"), context);
  return { first, next, handlers, context, body, key, post, get };
}
it("real proposal diff -> selected HTTP adoption -> immutable proof and downstream reader", async () => {
  const f = await fixture();
  const before = await db.forWorkspace(f.next.job.workspaceId, (r) =>
    r.wineEnrichment.readStage(f.next.run.id, "commit_candidate"),
  );
  const diff = await (await f.get()).json();
  expect(diff).toMatchObject({
    state: "available",
    runId: f.next.run.id,
    inputRevision: f.body.expectedInputRevision,
    baseVersionId: f.body.baseVersionId,
  });
  expect(diff.differences).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: "title.en", selectable: true }),
    ]),
  );
  expect(JSON.stringify(diff)).not.toMatch(
    /frozenQuality|evidenceIds|claimIds|authorization|operationKey/,
  );
  const result = await f.post();
  expect(result.status).toBe(200);
  const adopted = await result.json();
  expect((await f.post()).status).toBe(200);
  expect(
    (await f.post({ ...f.body, selectedPaths: ["title.zh-Hant"] })).status,
  ).toBe(409);
  expect(await (await f.get()).json()).toMatchObject({
    state: "adopted",
    adoptedVersionId: adopted.versionId,
  });
  await db.forWorkspace(f.next.job.workspaceId, async (r) => {
    const origin = await r.wineEnrichment.readVersionOrigin(
      f.next.run.listingId,
      adopted.versionId,
    );
    expect(origin).toMatchObject({
      pipelineIdempotencyKey: null,
      adoption: {
        proposalRunId: f.next.run.id,
        selectedPaths: ["title.en"],
        operationKey: f.key,
      },
    });
    const dependencies = await dbApi.readAdoptedWineDependencies(r, {
      workspaceId: f.next.job.workspaceId,
      listingId: f.next.run.listingId,
      versionId: adopted.versionId,
      inputRevision: f.body.expectedInputRevision,
    });
    expect(dependencies.status).toBe("available");
    if (dependencies.status !== "available" || !origin)
      throw Error("missing dependencies");
    const input = (await r.listingInputs.getCurrent(f.next.run.listingId))!;
    const ownership = dbApi.resolveWineGenerationOwnership(
      input,
      input.workingContent,
      origin.content,
      {
        workspaceId: f.next.job.workspaceId,
        listingId: f.next.run.listingId,
        operationId: randomUUID(),
        inputRevision: input.revision,
        baseVersionId: adopted.versionId,
      },
    );
    expect(
      dbApi.buildWineCopySnapshot({
        adopted: dependencies,
        input,
        ownership,
        mode: "copy",
        section: null,
        policy: wineEnrichmentPolicySchema.parse(
          f.next.run.execution.wineEnrichment,
        ),
        model: wineExecutionSnapshotSchema.parse(f.next.run.execution.wineGo),
      }).snapshot.claims.length,
    ).toBeGreaterThan(0);

    expect(
      await r.wineEnrichment.readStage(f.next.run.id, "commit_candidate"),
    ).toEqual(before);
    const progress = await readWineProgress(
      r,
      (await r.pipelineRuns.getOperation(f.next.run.id))!,
    );
    expect(progress).toMatchObject({
      state: "adopted",
      adoptedVersionId: adopted.versionId,
    });
  });
});
it.each([
  "sku",
  "priceHkd",
  "stockQuantity",
  "description.en",
  "sections.introduction.claimIds",
])("forbidden %s cannot mutate", async (path) => {
  const f = await fixture();
  expect((await f.post({ ...f.body, selectedPaths: [path] })).status).toBe(422);
  expect(
    await db.forWorkspace(f.next.job.workspaceId, (r) =>
      r.listings.getById(f.next.run.listingId),
    ),
  ).toMatchObject({ activeVersionId: f.body.baseVersionId });
});
it("two tabs cannot adopt changed input; read is stale", async () => {
  const f = await fixture();
  await db.forWorkspace(f.next.job.workspaceId, (r) =>
    r.listingInputs.save(
      {
        listingId: f.next.run.listingId,
        actorId: "tester",
        expectedInputRevision: f.body.expectedInputRevision,
        baseVersionId: f.body.baseVersionId,
        operationKey: randomUUID(),
        requestDigest: randomUUID(),
        changes: [
          {
            field: "title.en",
            value: "Manual title",
            state: "manual",
            locked: false,
          },
        ],
      },
      {
        workspaceId: f.next.job.workspaceId,
        actorId: "tester",
        entityId: f.next.run.listingId,
      },
      r.audit,
    ),
  );
  expect((await f.post()).status).toBe(409);
  expect(await (await f.get()).json()).toMatchObject({ state: "stale" });
});
it("concurrent same-key HTTP adoption creates exactly one version", async () => {
  const f = await fixture();
  const responses = await Promise.all([f.post(), f.post()]);
  expect(responses.map((r) => r.status)).toEqual([200, 200]);
  expect(await responses[0].json()).toEqual(await responses[1].json());
});
it("cross-tenant proposal is unavailable before any content read", async () => {
  const f = await fixture(),
    foreign = await fixture();
  const context = {
    params: Promise.resolve({ id: f.next.run.listingId, runId: f.next.run.id }),
  };
  expect(
    (await foreign.handlers.GET(new Request("http://localhost"), context))
      .status,
  ).toBe(404);
});

function altered(
  f: Awaited<ReturnType<typeof fixture>>,
  alter: (r: any) => any,
) {
  return createWineProposalHandlers({
    sessionContext: {
      resolve: async () => ({
        workspaceId: f.next.job.workspaceId,
        actorId: "tester",
        role: "operator",
      }),
    },
    getDatabase: () => ({
      forWorkspace: (ws, fn) => db.forWorkspace(ws, (r) => fn(alter(r))),
    }),
  });
}
function req(f: Awaited<ReturnType<typeof fixture>>) {
  return new Request("http://localhost/adopt", {
    method: "POST",
    headers: { "Idempotency-Key": f.key },
    body: JSON.stringify(f.body),
  });
}
async function counts(f: Awaited<ReturnType<typeof fixture>>) {
  return (
    await admin`select (select count(*) from listing_versions where workspace_id=${f.next.job.workspaceId}) versions,(select count(*) from wine_section_snapshots where workspace_id=${f.next.job.workspaceId}) sections,(select count(*) from audit_events where workspace_id=${f.next.job.workspaceId}) audits,(select count(*) from ai_budget_reservations where workspace_id=${f.next.job.workspaceId}) holds,(select count(*) from search_budget_reservations where workspace_id=${f.next.job.workspaceId}) search_holds`
  )[0];
}
it("expired actual web evidence blocks HTTP adoption without writes or budget holds", async () => {
  const f = await fixture(1),
    before = await counts(f);
  const handlers = altered(f, (r) => ({
    ...r,
    pipelineRuns: {
      ...r.pipelineRuns,
      acceptanceTimestamp: async () =>
        new Date(
          Date.parse(f.next.run.acceptedAt) + 8 * 86400000,
        ).toISOString(),
    },
  }));
  expect((await handlers.POST(req(f), f.context)).status).toBe(409);
  expect(
    await (
      await handlers.GET(new Request("http://localhost"), f.context)
    ).json(),
  ).toMatchObject({ state: "blocked", reason: "evidence_refresh_required" });
  expect(await counts(f)).toEqual(before);
});
it("revoked evidence is rechecked after displayed diff", async () => {
  const f = await fixture(1);
  expect(await (await f.get()).json()).toMatchObject({ state: "available" });
  const reviewer = randomUUID();
  await admin`insert into users(id,email) values(${reviewer},${reviewer + "@example.test"})`;
  await admin`insert into memberships(workspace_id,user_id,role) values(${f.next.job.workspaceId},${reviewer},'reviewer')`;
  await db.forWorkspace(f.next.job.workspaceId, (r) =>
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
  const before = await counts(f);
  expect((await f.post()).status).toBe(409);
  expect(await (await f.get()).json()).toMatchObject({ state: "blocked" });
  expect(await counts(f)).toEqual(before);
});
it("historical adopted identity survives manual edit and expired evidence; exact replay never reactivates", async () => {
  const f = await fixture(1);
  const adopted = await (await f.post()).json();
  const newer = await db.forWorkspace(f.next.job.workspaceId, async (r) => {
    const origin = (await r.wineEnrichment.readVersionOrigin(
      f.next.run.listingId,
      adopted.versionId,
    ))!;
    const audit = {
      workspaceId: f.next.job.workspaceId,
      actorId: "tester",
      entityId: f.next.run.listingId,
    };
    const version = await r.listings.appendVersion(
      f.next.run.listingId,
      { ...origin.content, stockQuantity: 22 },
      audit,
      r.audit,
    );
    await r.listings.complete(
      f.next.run.listingId,
      {
        status: "in_review",
        versionId: version.id,
        idempotencyKey: randomUUID(),
      },
      audit,
      r.audit,
    );
    return version.id;
  });
  const history = altered(f, (r) => ({
    ...r,
    pipelineRuns: {
      ...r.pipelineRuns,
      acceptanceTimestamp: async () =>
        new Date(
          Date.parse(f.next.run.acceptedAt) + 8 * 86400000,
        ).toISOString(),
    },
  }));
  expect(
    await (
      await history.GET(new Request("http://localhost"), f.context)
    ).json(),
  ).toMatchObject({
    state: "adopted",
    adoptedVersionId: adopted.versionId,
    current: { activeVersionId: newer },
  });
  expect(await (await f.post()).json()).toMatchObject({
    versionId: adopted.versionId,
    current: { activeVersionId: newer },
  });
});
it("actual savepoint rolls back when section persistence fails through HTTP", async () => {
  const f = await fixture(),
    before = await counts(f);
  const handlers = altered(f, (r) => ({
    ...r,
    wineEnrichment: {
      ...r.wineEnrichment,
      saveSections: async () => {
        throw Error("synthetic downstream failure");
      },
    },
  }));
  expect((await handlers.POST(req(f), f.context)).status).toBe(500);
  expect(await counts(f)).toEqual(before);
  expect(await (await f.get()).json()).toMatchObject({ state: "available" });
});
it("malformed immutable adoption history is blocked, never adopted", async () => {
  const f = await fixture();
  await f.post();
  const handlers = altered(f, (r) => ({
    ...r,
    wineEnrichment: {
      ...r.wineEnrichment,
      readAdoptionByProposalRun: async (...args: any[]) => {
        const row = await r.wineEnrichment.readAdoptionByProposalRun(...args);
        return { ...row, adoption: { ...row.adoption, actorId: "forged" } };
      },
    },
  }));
  expect(
    await (
      await handlers.GET(new Request("http://localhost"), f.context)
    ).json(),
  ).toMatchObject({
    state: "blocked",
    reason: "proposal_adoption_invalid",
    adoptedVersionId: null,
  });
});
it("rejected generation without terminal proposal is explained without leaking provider payload", async () => {
  const f = await fixture();
  const handlers = altered(f, (r) => ({
    ...r,
    wineEnrichment: {
      ...r.wineEnrichment,
      readStage: async (runId: string, stage: string) => {
        if (stage === "commit_candidate") return null;
        const row = await r.wineEnrichment.readStage(runId, stage);
        return stage === "generation"
          ? {
              ...row,
              output: {
                schemaVersion: 1,
                fresh: false,
                rejectedResult: row.output.result,
              },
            }
          : row;
      },
    },
  }));
  const response = await handlers.GET(
    new Request("http://localhost"),
    f.context,
  );
  expect(await response.json()).toMatchObject({
    state: "rejected",
    reason: "proposal_rejected",
    differences: [],
  });
});
it.each(["stale", "rejected"])(
  "%s proposal text is sanitized and never selectable",
  async (state) => {
    const f = await fixture();
    const handlers = altered(f, (r) => ({
      ...r,
      wineEnrichment: {
        ...r.wineEnrichment,
        readStage: async (runId: string, stage: string) => {
          const row = await r.wineEnrichment.readStage(runId, stage);
          if (stage !== "commit_candidate") return row;
          const result = structuredClone(row.output.result);
          result.proposal.content.title.en =
            "Authorization: Bearer privatecredential See https://private.test/token";
          result.proposal.contentDigest = dbApi.listingInputDigest(
            result.proposal.content,
          );
          return {
            ...row,
            output: {
              schemaVersion: 1,
              fresh: false,
              ...(state === "rejected"
                ? { rejectedResult: result }
                : { result }),
            },
          };
        },
      },
    }));
    const dto = await (
      await handlers.GET(new Request("http://localhost"), f.context)
    ).json();
    expect(dto.state).toBe(state);
    expect(dto.differences.length).toBeGreaterThan(0);
    expect(dto.differences.every((d: any) => !d.selectable)).toBe(true);
    expect(JSON.stringify(dto)).not.toMatch(
      /privatecredential|private.test|claimIds|frozenQuality/,
    );
  },
);
it("concurrent input edit and adoption serialize on the current input/base", async () => {
  const f = await fixture();
  const edit = db.forWorkspace(f.next.job.workspaceId, (r) =>
    r.listingInputs.save(
      {
        listingId: f.next.run.listingId,
        actorId: "tester",
        expectedInputRevision: f.body.expectedInputRevision,
        baseVersionId: f.body.baseVersionId,
        operationKey: randomUUID(),
        requestDigest: randomUUID(),
        changes: [
          {
            field: "title.en",
            value: "Concurrent manual title",
            state: "manual",
            locked: true,
          },
        ],
      },
      {
        workspaceId: f.next.job.workspaceId,
        actorId: "tester",
        entityId: f.next.run.listingId,
      },
      r.audit,
    ),
  );
  const results = await Promise.allSettled([edit, f.post()]);
  const post = results[1];
  expect(post.status).toBe("fulfilled");
  if (post.status !== "fulfilled") throw Error("HTTP failed");
  if (results[0].status === "fulfilled") {
    expect(post.value.status).toBe(409);
    expect(await (await f.get()).json()).toMatchObject({ state: "stale" });
  } else {
    expect(post.value.status).toBe(200);
    expect(await (await f.get()).json()).toMatchObject({ state: "adopted" });
  }
});
