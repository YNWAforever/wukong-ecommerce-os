import { z } from "zod";
import {
  productIdentitySchema,
  type EvidenceSource,
} from "./wine-enrichment-contracts.js";
const fields = productIdentitySchema.options[0].shape;
/** Coordinates only: no category, observation, claim or trust is inherited. */
export const wineIdentityCoordinatesSchema = z
  .object({
    kind: z.enum(["wine", "spirits", "sake"]),
    producer: z.string().min(1),
    productName: z.string().min(1),
    cuvee: fields.cuvee,
    vintage: fields.vintage,
    volumeMl: z.number().positive(),
    packQuantity: z.number().int().positive(),
    marketVariant: fields.marketVariant,
    barcode: fields.barcode,
  })
  .strict();
export type WineIdentityCoordinates = z.infer<
  typeof wineIdentityCoordinatesSchema
>;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const wineIdentitySelectionSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceId: z.string().min(1),
    listingId: z.uuid(),
    sourceRunId: z.uuid(),
    sourceStage: z.enum(["verification", "verification_deep"]),
    sourceId: z.uuid(),
    sourceInputRevision: z.number().int().positive(),
    sourceInputDigest: digest,
    sourceBaseVersionId: z.uuid().nullable(),
    sourceStageDigest: digest,
    identityDigest: digest,
    selectedIdentity: wineIdentityCoordinatesSchema,
    selectedBy: z.string().min(1),
    selectedAt: z.iso.datetime({ offset: true }),
    selectedInputRevision: z.number().int().positive(),
    contextDigest: digest,
  })
  .strict();
export type WineIdentitySelection = z.infer<typeof wineIdentitySelectionSchema>;
export type WineIdentityAssertion = {
  identity: WineIdentityCoordinates;
  source: EvidenceSource;
};
export const WINE_IDENTITY_ASSERTION_TITLE =
  "Merchant identity selection (not observed evidence)";
export function wineIdentityAssertionText(identity: WineIdentityCoordinates) {
  return (
    "Merchant identity selection: " +
    JSON.stringify(wineIdentityCoordinatesSchema.parse(identity))
  );
}
