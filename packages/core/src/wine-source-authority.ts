import { z } from "zod";
import { sameProductIdentity } from "./matched-enrichment.js";
import type { EvidenceSource } from "./wine-enrichment-contracts.js";

export const wineSourceAuthoritySchema = z
  .object({
    schemaVersion: z.literal(1),
    domain: z.string().regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\.[a-z]{2,}$/),
    subject: z
      .object({
        kind: z.enum(["producer", "authority"]),
        name: z.string().trim().min(1),
      })
      .strict(),
    proofUrl: z.url().refine((value) => value.startsWith("https://")),
    proofDigest: z.string().regex(/^[a-f0-9]{64}$/),
    verifiedAt: z.iso.datetime({ offset: true }),
    expiresAt: z.iso.datetime({ offset: true }),
    revokedAt: z.iso.datetime({ offset: true }).nullable(),
    verifierId: z.string().trim().min(1),
  })
  .strict()
  .refine(
    (entry) => Date.parse(entry.expiresAt) > Date.parse(entry.verifiedAt),
    "Review expiry must follow verification",
  );
export type WineSourceAuthority = z.infer<typeof wineSourceAuthoritySchema>;
/** Registry data must come from the reviewed persisted registry, never a provider answer. No ambient clock. */
export function resolveWineSourceAuthority(
  source: EvidenceSource,
  subject: WineSourceAuthority["subject"],
  entries: readonly WineSourceAuthority[],
  now: string,
): WineSourceAuthority | null {
  if (
    source.kind !== "web" ||
    !source.url ||
    !source.domain ||
    !Number.isFinite(Date.parse(now))
  )
    return null;
  try {
    if (
      new URL(source.url).protocol !== "https:" ||
      new URL(source.url).hostname !== source.domain
    )
      return null;
  } catch {
    return null;
  }
  const matching = entries.filter(
    (entry) =>
      wineSourceAuthoritySchema.safeParse(entry).success &&
      entry.domain === source.domain &&
      entry.subject.kind === subject.kind &&
      sameProductIdentity(entry.subject.name, subject.name),
  );
  // A revocation wins over stale active copies supplied alongside it.
  if (
    matching.some(
      (entry) =>
        entry.revokedAt !== null &&
        Date.parse(entry.revokedAt) <= Date.parse(now),
    )
  )
    return null;
  return (
    matching.find(
      (entry) =>
        entry.revokedAt === null &&
        Date.parse(entry.verifiedAt) <= Date.parse(now) &&
        Date.parse(now) < Date.parse(entry.expiresAt),
    ) ?? null
  );
}
