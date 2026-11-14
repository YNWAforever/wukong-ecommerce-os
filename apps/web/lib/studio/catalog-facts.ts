import { z } from "zod";
import type { StudioComposeInput } from "@wukong/ai";
import type { EvidencePack } from "./types";

export type CatalogFacts = NonNullable<StudioComposeInput["recordFacts"]>;
export const CATALOG_QUERY_REF = "catalog-query:executed";

const ref = z.string().min(1).max(200);
const catalogFactsSchema = z.strictObject({
  query: z.strictObject({ text: z.string().min(1).max(200), evidenceRef: ref }),
  catalogRecords: z
    .array(
      z.strictObject({
        evidenceRef: ref,
        listingId: ref,
        title: z.string().max(200),
        status: z.string().max(40),
      }),
    )
    .max(5),
  jobs: z
    .array(
      z.strictObject({
        evidenceRef: ref,
        jobId: ref,
        state: z.string().max(40),
        createdAt: z.string().max(64),
      }),
    )
    .max(5),
});

/** Only allowlisted fields with currently available, unrestricted source refs. */
export function catalogFactsForComposer(
  pack: EvidencePack,
): CatalogFacts | undefined {
  const parsed = catalogFactsSchema.safeParse(pack.context.catalogFacts);
  if (!parsed.success) return undefined;
  const sources = new Map(
    pack.sources
      .filter((source) => source.coverage === "present" && !source.restricted)
      .map((source) => [source.ref, source]),
  );
  const facts = parsed.data;
  const query = sources.get(facts.query.evidenceRef);
  if (query?.kind !== "catalog" || query.refId !== facts.query.text)
    return undefined;
  return {
    query: facts.query,
    catalogRecords: facts.catalogRecords.filter((record) => {
      const source = sources.get(record.evidenceRef);
      return source?.kind === "catalog" && source.refId === record.listingId;
    }),
    jobs: facts.jobs.filter((job) => {
      const source = sources.get(job.evidenceRef);
      return source?.kind === "job" && source.refId === job.jobId;
    }),
  };
}

/** Apply the same availability boundary to facts, labels and duplicated checks. */
export function composerEvidenceForPack(pack: EvidencePack) {
  const recordFacts = catalogFactsForComposer(pack);
  const available = pack.sources.filter(
    (source) => source.coverage === "present" && !source.restricted,
  );
  const listingIds = new Set(
    available
      .filter(
        (source) =>
          (source.kind === "catalog" && source.ref !== CATALOG_QUERY_REF) ||
          source.kind === "listing",
      )
      .map((source) => source.refId),
  );
  const recordIds = new Set(
    recordFacts?.catalogRecords.map((record) => record.listingId),
  );
  const jobIds = new Set(recordFacts?.jobs.map((job) => job.jobId));
  const factRefs = new Set(
    recordFacts
      ? [
          recordFacts.query.evidenceRef,
          ...recordFacts.catalogRecords.map((record) => record.evidenceRef),
          ...recordFacts.jobs.map((job) => job.evidenceRef),
        ]
      : [],
  );
  const ordered = [
    ...available.filter((source) => factRefs.has(source.ref)),
    ...available.filter((source) => !factRefs.has(source.ref)),
  ];
  return {
    recordFacts,
    sources: ordered
      .slice(0, 20)
      .map((source) => ({
        ref: source.ref.slice(0, 200),
        kind: source.kind,
        label: source.label.slice(0, 120),
      })),
    checks: pack.checks
      .filter((check) => {
        if (check.key === "studio.check.catalog_query")
          return recordFacts !== undefined;
        if (check.key === "studio.check.catalog_record")
          return recordIds.has(String(check.values.listingId));
        if (check.key === "studio.check.recent_job")
          return jobIds.has(String(check.values.jobId));
        if (typeof check.values.listingId === "string")
          return listingIds.has(check.values.listingId);
        return true;
      })
      .slice(0, 30)
      .map((check) => ({
        key: check.key,
        state: check.state,
        values: check.values,
      })),
  };
}
