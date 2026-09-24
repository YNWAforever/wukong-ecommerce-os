import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, it, expect } from "vitest";
import { createDatabase } from "@wukong/db";
import { emptyWorkingListing } from "@wukong/core";
import { createAdoptListingCandidateHandler } from "./route";
import { createListingRunHandler } from "../route";
const workspaceId = `candidate-${randomUUID()}`;
const database = createDatabase(
  process.env.TEST_DATABASE_URL ??
    "postgres://wukong_app:wukong-app-local@localhost:54329/wukong",
  {
    migrationUrl:
      process.env.TEST_DATABASE_ADMIN_URL ??
      "postgres://wukong:wukong@localhost:54329/wukong",
  },
);
beforeAll(() => database.migrate());
afterAll(() => database.close());
it("reads scoped candidate and adopts selected stored values once under revision/base CAS", async () => {
  const { id, run, current } = await database.forWorkspace(
    workspaceId,
    async (r) => {
      const listing = await r.listings.create({ target: "shopline" });
      const context = { workspaceId, actorId: "human", entityId: listing.id };
      const initial = await r.listingInputs.initialize(
        { listingId: listing.id, actorId: "human" },
        context,
        r.audit,
      );
      const run = await r.pipelineRuns.acceptOperation({
        listingId: listing.id,
        inputRevision: initial.revision,
        baseVersionId: null,
        activeVersionSequence: 0,
        requestKey: randomUUID(),
        requestDigest: "a".repeat(64),
        execution: { input: initial },
      });
      const current = await r.listingInputs.save(
        {
          listingId: listing.id,
          actorId: "human",
          expectedInputRevision: initial.revision,
          baseVersionId: null,
          operationKey: randomUUID(),
          requestDigest: "b".repeat(64),
          changes: [{ field: "title.en", value: "Human edit" }],
        },
        context,
        r.audit,
      );
      await r.pipelineRuns.setOperationState(
        run.id,
        "superseded",
        "input_superseded",
        {
          content: {
            ...emptyWorkingListing(),
            title: { en: "Stored candidate", "zh-Hant": "" },
          },
          evidence: [],
        },
      );
      return { id: listing.id, run, current };
    },
  );
  const deps = {
    sessionContext: {
      resolve: async () => ({
        workspaceId,
        actorId: "human",
        role: "operator" as const,
      }),
    },
    getDatabase: () => database,
  };
  const context = { params: Promise.resolve({ id, runId: run.id }) };
  const view = await createListingRunHandler(deps)(
    new Request("https://test"),
    context,
  );
  expect(view.status).toBe(200);
  expect(
    (await view.json()).candidate.fields.find(
      (f: any) => f.field === "title.en",
    ).value,
  ).toBe("Stored candidate");
  const key = randomUUID();
  const request = () =>
    new Request("https://test", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": key },
      body: JSON.stringify({
        expectedInputRevision: current.revision,
        baseVersionId: null,
        selectedFieldPaths: ["title.en"],
      }),
    });
  const handler = createAdoptListingCandidateHandler(deps);
  const first = await handler(request(), context);
  expect(first.status).toBe(200);
  const response = await first.json();
  expect(await (await handler(request(), context)).json()).toEqual(response);
  const saved = await database.forWorkspace(workspaceId, (r) =>
    r.listingInputs.getCurrent(id),
  );
  expect(saved?.workingContent.title.en).toBe("Stored candidate");
  expect(saved?.fieldStates["title.en"]?.candidateRunId).toBe(run.id);
  const foreign = createListingRunHandler({
    ...deps,
    sessionContext: {
      resolve: async () => ({
        workspaceId: "foreign",
        actorId: "other",
        role: "operator" as const,
      }),
    },
  });
  expect((await foreign(new Request("https://test"), context)).status).toBe(
    404,
  );
});

it("rejects locked fields and allows only one concurrent explicit adoption", async () => {
  const initial = await database.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const context = { workspaceId, actorId: "human", entityId: listing.id };
    const snapshot = await r.listingInputs.initialize(
      { listingId: listing.id, actorId: "human" },
      context,
      r.audit,
    );
    const run = await r.pipelineRuns.acceptOperation({
      listingId: listing.id,
      inputRevision: snapshot.revision,
      baseVersionId: null,
      activeVersionSequence: 0,
      requestKey: randomUUID(),
      requestDigest: "c".repeat(64),
      execution: { input: snapshot },
    });
    const locked = await r.listingInputs.save(
      {
        listingId: listing.id,
        actorId: "human",
        expectedInputRevision: snapshot.revision,
        baseVersionId: null,
        operationKey: randomUUID(),
        requestDigest: "d".repeat(64),
        changes: [{ field: "title.en", value: "Locked human", locked: true }],
      },
      context,
      r.audit,
    );
    await r.pipelineRuns.setOperationState(
      run.id,
      "superseded",
      "input_superseded",
      {
        content: {
          ...emptyWorkingListing(),
          title: { en: "Candidate text", "zh-Hant": "" },
        },
        evidence: [],
      },
    );
    return { listing, run, locked };
  });
  const context = {
    params: Promise.resolve({ id: initial.listing.id, runId: initial.run.id }),
  };
  const deps = {
    sessionContext: {
      resolve: async () => ({
        workspaceId,
        actorId: "human",
        role: "operator" as const,
      }),
    },
    getDatabase: () => database,
  };
  const handler = createAdoptListingCandidateHandler(deps);
  const request = (revision: number) =>
    new Request("https://test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        expectedInputRevision: revision,
        baseVersionId: null,
        selectedFieldPaths: ["title.en"],
      }),
    });
  const locked = await handler(request(initial.locked.revision), context);
  expect(locked.status).toBe(409);
  expect((await locked.json()).code).toBe("field_locked");
  const unlocked = await database.forWorkspace(workspaceId, (r) =>
    r.listingInputs.save(
      {
        listingId: initial.listing.id,
        actorId: "human",
        expectedInputRevision: initial.locked.revision,
        baseVersionId: null,
        operationKey: randomUUID(),
        requestDigest: "e".repeat(64),
        changes: [{ field: "title.en", value: "Locked human", locked: false }],
      },
      { workspaceId, actorId: "human", entityId: initial.listing.id },
      r.audit,
    ),
  );
  const outcomes = await Promise.all([
    handler(request(unlocked.revision), context),
    handler(request(unlocked.revision), context),
  ]);
  expect(outcomes.map((r) => r.status).sort()).toEqual([200, 409]);
  const viewer = createAdoptListingCandidateHandler({
    ...deps,
    sessionContext: {
      resolve: async () => ({
        workspaceId,
        actorId: "viewer",
        role: "viewer" as const,
      }),
    },
  });
  expect((await viewer(request(unlocked.revision), context)).status).toBe(403);
});
it("explicitly adopts a populated fact from failed extraction without blank copy", async () => {
  const fixture = await database.forWorkspace(workspaceId, async (r) => {
    const listing = await r.listings.create({ target: "shopline" });
    const audit = { workspaceId, actorId: "human", entityId: listing.id };
    const initial = await r.listingInputs.initialize(
      { listingId: listing.id, actorId: "human" },
      audit,
      r.audit,
    );
    const run = await r.pipelineRuns.acceptOperation({
      listingId: listing.id,
      inputRevision: 1,
      baseVersionId: null,
      activeVersionSequence: 0,
      requestKey: randomUUID(),
      requestDigest: "a".repeat(64),
      execution: { input: initial },
    });
    await r.pipelineRuns.setOperationState(
      run.id,
      "failed",
      "provider_failed",
      {
        stage: "extract",
        content: { ...emptyWorkingListing(), producer: "Extracted producer" },
        evidence: [],
      },
    );
    return { listing, run };
  });
  const handler = createAdoptListingCandidateHandler({
    sessionContext: {
      resolve: async () => ({
        workspaceId,
        actorId: "human",
        role: "operator" as const,
      }),
    },
    getDatabase: () => database,
  });
  const response = await handler(
    new Request("https://test", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": randomUUID(),
      },
      body: JSON.stringify({
        expectedInputRevision: 1,
        baseVersionId: null,
        selectedFieldPaths: ["producer"],
      }),
    }),
    {
      params: Promise.resolve({
        id: fixture.listing.id,
        runId: fixture.run.id,
      }),
    },
  );
  expect(response.status).toBe(200);
  const saved = await database.forWorkspace(workspaceId, (r) =>
    r.listingInputs.getCurrent(fixture.listing.id),
  );
  expect(saved?.workingContent.producer).toBe("Extracted producer");
  expect(saved?.workingContent.title.en).toBe("");
  expect(saved?.revision).toBe(2);
  expect(saved?.fieldStates.producer?.candidateRunId).toBe(fixture.run.id);
});
