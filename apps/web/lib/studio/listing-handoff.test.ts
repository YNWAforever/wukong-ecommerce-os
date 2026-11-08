import { describe, expect, it } from "vitest";

import type { StudioOutput, StudioOutputVersion } from "@wukong/db";

import type { SessionContextPort } from "../session-context-port";
import {
  copyProposalHandoffFromBundle,
  loadListingStudioHandoff,
} from "./listing-handoff";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
} from "./test-fakes";

/**
 * Review-screen Studio handoff resolver (B2).
 *
 * Every success path requires a same-workspace copy_proposal whose payload
 * names the same listing; everything else must resolve to `undefined` so the
 * listing page renders unchanged. These tests use the injected session/database
 * fakes and never touch a live Postgres.
 */

const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;
const WORKSPACE = "ws_test";
const OUTPUT_ID = "55555555-5555-4555-8555-555555555555";
const LISTING_ID = "00000000-0000-4000-8000-000000000101";
const CREATED_AT = new Date("2026-11-08T10:00:00.000Z");

function proposalPayload(overrides: Record<string, unknown> = {}) {
  return {
    listingId: LISTING_ID,
    activeVersionId: "version-1",
    activeVersionSequence: 7,
    fields: [
      {
        field: "title.en",
        current: "Synthetic old title",
        proposed: "Synthetic proposed title",
        evidenceRefs: ["listing:listing-1:v7"],
      },
      {
        field: "description.zh-Hant",
        current: null,
        proposed: "合成建議描述",
        evidenceRefs: ["quality:v1"],
      },
    ],
    limitations: [],
    asOf: "2026-11-08T10:00:00.000Z",
    ...overrides,
  };
}

function outputRow(overrides: Partial<StudioOutput> = {}): StudioOutput {
  return {
    id: OUTPUT_ID,
    workspaceId: WORKSPACE,
    threadId: null,
    runId: null,
    kind: "copy_proposal",
    title: "Synthetic copy proposal",
    status: "saved",
    currentVersion: 1,
    createdBy: "actor_ops",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function versionRow(payload: unknown): StudioOutputVersion {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    workspaceId: WORKSPACE,
    outputId: OUTPUT_ID,
    revision: 3,
    payload: payload as Record<string, unknown>,
    contentDigest: "a".repeat(64),
    asOf: CREATED_AT,
    scope: { workspaceScoped: true },
    createdBy: "actor_ops",
    createdAt: CREATED_AT,
  };
}

function fixture(
  input: {
    payload?: Record<string, unknown>;
    output?: Partial<StudioOutput>;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const fake = createFakeStudio({
    settings: { workspaceId: WORKSPACE, enabled: true },
    outputs: [outputRow(input.output)],
    outputVersions: [versionRow(input.payload ?? proposalPayload())],
  });
  return {
    env: input.env ?? ON_ENV,
    sessionContext: fakeSessionContext("viewer", { workspaceId: WORKSPACE })
      .port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
  };
}

describe("copyProposalHandoffFromBundle", () => {
  const baseBundle = {
    output: {
      outputId: OUTPUT_ID,
      kind: "copy_proposal",
      title: "Synthetic copy proposal",
    },
    versions: [
      {
        revision: 1,
        payload: proposalPayload({ activeVersionSequence: 1 }) as Record<
          string,
          unknown
        >,
        asOf: "2026-11-08T09:00:00.000Z",
      },
      {
        revision: 3,
        payload: proposalPayload(),
        asOf: CREATED_AT.toISOString(),
      },
    ],
  };

  it("projects the latest version into the minimal read-only banner payload", () => {
    const handoff = copyProposalHandoffFromBundle({
      listingId: LISTING_ID,
      bundle: baseBundle,
    });
    expect(handoff).toMatchObject({
      outputId: OUTPUT_ID,
      title: "Synthetic copy proposal",
      revision: 3,
      asOf: CREATED_AT.toISOString(),
    });
    // Raw field ids and current -> proposed only; evidence refs are not needed
    // to copy a value and are not part of the handoff contract.
    expect(handoff?.fields).toEqual([
      {
        field: "title.en",
        current: "Synthetic old title",
        proposed: "Synthetic proposed title",
      },
      {
        field: "description.zh-Hant",
        current: null,
        proposed: "合成建議描述",
      },
    ]);
  });

  it("fails closed for another listing, another kind or an invalid payload", () => {
    expect(
      copyProposalHandoffFromBundle({
        listingId: LISTING_ID,
        bundle: {
          ...baseBundle,
          output: { ...baseBundle.output, kind: "merchant_audit" },
        },
      }),
    ).toBeUndefined();
    expect(
      copyProposalHandoffFromBundle({
        listingId: "some-other-listing",
        bundle: baseBundle,
      }),
    ).toBeUndefined();
    expect(
      copyProposalHandoffFromBundle({
        listingId: LISTING_ID,
        bundle: {
          ...baseBundle,
          versions: [
            {
              revision: 1,
              payload: { listingId: LISTING_ID, fields: "nope" },
              asOf: CREATED_AT.toISOString(),
            },
          ],
        },
      }),
    ).toBeUndefined();
  });
});

describe("loadListingStudioHandoff", () => {
  it("resolves a same-workspace proposal for the same listing", async () => {
    const handoff = await loadListingStudioHandoff({
      listingId: LISTING_ID,
      studioOutput: OUTPUT_ID,
      deps: fixture(),
    });
    expect(handoff?.outputId).toBe(OUTPUT_ID);
    expect(handoff?.fields).toHaveLength(2);
  });

  it("ignores a non-UUID query value without touching the database", async () => {
    let dbCalls = 0;
    const deps = {
      sessionContext: fakeSessionContext("viewer", {
        workspaceId: WORKSPACE,
      }).port,
      getDatabase: () => {
        dbCalls += 1;
        throw new Error("must not be called");
      },
    };
    for (const value of ["not-a-uuid", "55555555-5555-4555", "x".repeat(36)]) {
      expect(
        await loadListingStudioHandoff({
          listingId: LISTING_ID,
          studioOutput: value,
          deps,
        }),
      ).toBeUndefined();
    }
    expect(dbCalls).toBe(0);
  });

  it("ignores a missing session", async () => {
    const deps = fixture();
    const noSession: SessionContextPort = { resolve: async () => null };
    expect(
      await loadListingStudioHandoff({
        listingId: LISTING_ID,
        studioOutput: OUTPUT_ID,
        deps: { ...deps, sessionContext: noSession },
      }),
    ).toBeUndefined();
  });

  it("ignores disabled Studio, foreign/unknown ids and database errors", async () => {
    expect(
      await loadListingStudioHandoff({
        listingId: LISTING_ID,
        studioOutput: OUTPUT_ID,
        deps: fixture({ env: {} as NodeJS.ProcessEnv }),
      }),
    ).toBeUndefined();

    const unknownId = "88888888-8888-4888-8888-888888888888";
    expect(
      await loadListingStudioHandoff({
        listingId: LISTING_ID,
        studioOutput: unknownId,
        deps: fixture(),
      }),
    ).toBeUndefined();

    expect(
      await loadListingStudioHandoff({
        listingId: LISTING_ID,
        studioOutput: OUTPUT_ID,
        deps: {
          ...fixture(),
          getDatabase: () =>
            ({
              forWorkspace: async () => {
                throw new Error("database unavailable");
              },
            }) as never,
        },
      }),
    ).toBeUndefined();
  });

  it("ignores a mismatched listing and a non-proposal artifact", async () => {
    expect(
      await loadListingStudioHandoff({
        listingId: "00000000-0000-4000-8000-000000000999",
        studioOutput: OUTPUT_ID,
        deps: fixture(),
      }),
    ).toBeUndefined();
    expect(
      await loadListingStudioHandoff({
        listingId: LISTING_ID,
        studioOutput: OUTPUT_ID,
        deps: fixture({ output: { kind: "merchant_audit" } }),
      }),
    ).toBeUndefined();
  });
});
