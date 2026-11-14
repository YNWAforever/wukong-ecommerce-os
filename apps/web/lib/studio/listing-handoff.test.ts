import { describe, expect, it } from "vitest";

import type { StudioOutput, StudioOutputVersion } from "@wukong/db";

import type { SessionContextPort } from "../session-context-port";
import { outputPayloadDigest } from "./output-service";
import {
  copyProposalHandoffFromBundle,
  loadListingStudioHandoff,
} from "./listing-handoff";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  reviewSnapshot,
  reviewableContent,
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
    currentVersion: 3,
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
    contentDigest: outputPayloadDigest(payload),
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
    snapshots: {
      [LISTING_ID]: reviewSnapshot({
        listingId: LISTING_ID,
        versionId: "version-1",
        sequence: 7,
        content: reviewableContent(),
      }),
    },
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

  const latestDigest = outputPayloadDigest(proposalPayload());
  const firstDigest = outputPayloadDigest(baseBundle.versions[0]!.payload);
  const pinnedBundle = {
    ...baseBundle,
    output: { ...baseBundle.output, currentVersion: 3 },
    versions: baseBundle.versions.map((version) => ({
      ...version,
      contentDigest: outputPayloadDigest(version.payload),
    })),
  };
  const currentListingVersion = { versionId: "version-1", sequence: 7 };

  it.each(["stale", "unavailable"] as const)(
    "honors %s server freshness even when the listing version matches",
    (freshness) => {
      const handoff = copyProposalHandoffFromBundle({
        listingId: LISTING_ID,
        bundle: {
          ...pinnedBundle,
          output: { ...pinnedBundle.output, freshness },
        },
        pin: { revision: 3, digest: latestDigest },
        currentListingVersion,
      });
      expect(handoff?.state).toBe(freshness);
      if (freshness === "unavailable") expect(handoff?.fields).toEqual([]);
    },
  );

  it("resolves an exact current version and detects listing changes", () => {
    const input = {
      listingId: LISTING_ID,
      bundle: pinnedBundle,
      pin: { revision: 3, digest: latestDigest },
      currentListingVersion,
    };
    expect(copyProposalHandoffFromBundle(input)).toMatchObject({
      revision: 3,
      state: "current",
    });
    expect(
      copyProposalHandoffFromBundle({
        ...input,
        currentListingVersion: { versionId: "version-2", sequence: 8 },
      }),
    ).toMatchObject({ revision: 3, state: "stale" });
    expect(
      copyProposalHandoffFromBundle({ ...input, currentListingVersion: null }),
    ).toMatchObject({ state: "unavailable", fields: [] });
  });

  it("rejects content altered behind an unchanged digest column", () => {
    const corrupt = {
      ...pinnedBundle,
      versions: pinnedBundle.versions.map((version) =>
        version.revision === 3
          ? {
              ...version,
              payload: { ...version.payload, limitations: ["altered"] },
            }
          : version,
      ),
    };
    expect(
      copyProposalHandoffFromBundle({
        listingId: LISTING_ID,
        bundle: corrupt,
        pin: { revision: 3, digest: latestDigest },
        currentListingVersion,
      }),
    ).toMatchObject({ state: "unavailable", fields: [] });
  });

  it("keeps a historical pinned version instead of retargeting latest", () => {
    const handoff = copyProposalHandoffFromBundle({
      listingId: LISTING_ID,
      bundle: pinnedBundle,
      pin: { revision: 1, digest: firstDigest },
      currentListingVersion,
    });
    expect(handoff).toMatchObject({
      revision: 1,
      asOf: "2026-11-08T09:00:00.000Z",
      state: "stale",
    });
  });

  it("shows no proposal fields for missing revisions or mismatched digests", () => {
    for (const pin of [
      { revision: 4, digest: "a".repeat(64) },
      { revision: 3, digest: "b".repeat(64) },
    ]) {
      expect(
        copyProposalHandoffFromBundle({
          listingId: LISTING_ID,
          bundle: pinnedBundle,
          pin,
          currentListingVersion,
        }),
      ).toMatchObject({ state: "unavailable", fields: [] });
    }
  });

  it("projects legacy links with an explicit unpinned state", () => {
    const handoff = copyProposalHandoffFromBundle({
      listingId: LISTING_ID,
      bundle: baseBundle,
    });
    expect(handoff).toMatchObject({
      outputId: OUTPUT_ID,
      title: "Synthetic copy proposal",
      revision: 3,
      asOf: CREATED_AT.toISOString(),
      state: "unpinned",
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
  it("resolves a pinned proposal against the current listing version", async () => {
    const handoff = await loadListingStudioHandoff({
      listingId: LISTING_ID,
      studioOutput: OUTPUT_ID,
      studioRevision: "3",
      studioDigest: outputPayloadDigest(proposalPayload()),
      deps: fixture(),
    });
    expect(handoff).toMatchObject({ revision: 3, state: "current" });
  });

  it("rejects malformed or incomplete pins before any database work", async () => {
    const deps = fixture();
    let reads = 0;
    const getDatabase = () => {
      reads += 1;
      return deps.getDatabase();
    };
    for (const pin of [
      { studioRevision: "3" },
      { studioDigest: "a".repeat(64) },
      { studioRevision: "01", studioDigest: "a".repeat(64) },
      { studioRevision: "9007199254740992", studioDigest: "a".repeat(64) },
      { studioRevision: "3", studioDigest: "A".repeat(64) },
    ]) {
      expect(
        await loadListingStudioHandoff({
          listingId: LISTING_ID,
          studioOutput: OUTPUT_ID,
          ...pin,
          deps: { ...deps, getDatabase },
        }),
      ).toBeUndefined();
    }
    expect(reads).toBe(0);
  });

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
