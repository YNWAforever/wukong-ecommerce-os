import { z } from "zod";

export type WineKind = "wine" | "spirits" | "sake";
export type Vintage =
  | { state: "known"; year: number }
  | { state: "unknown" | "not_applicable"; year: null };
export type IdentityStatus = "candidate" | "matched" | "needs_confirmation";
export type FieldObservation = {
  value: string | number | string[] | null;
  state: "observed" | "normalized" | "unknown" | "not_applicable" | "conflict";
  evidenceIds: string[];
};

const evidenceIdSchema = z.uuid();
const finiteNumberSchema = z.number().finite();

export const fieldObservationSchema = z
  .object({
    value: z.union([
      z.string(),
      finiteNumberSchema,
      z.array(z.string()),
      z.null(),
    ]),
    state: z.enum([
      "observed",
      "normalized",
      "unknown",
      "not_applicable",
      "conflict",
    ]),
    evidenceIds: z.array(evidenceIdSchema),
  })
  .strict()
  .superRefine((observation, context) => {
    const hasValue = ["observed", "normalized", "conflict"].includes(
      observation.state,
    );
    if (hasValue && observation.value === null) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Known observations require a value",
      });
    }
    if (hasValue && observation.evidenceIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message: "Known observations require evidence",
      });
    }
    if (!hasValue && observation.value !== null) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Unknown observations must use null",
      });
    }
  });

const polishingPercentObservationSchema = fieldObservationSchema.superRefine(
  (observation, context) => {
    const isKnown = ["observed", "normalized", "conflict"].includes(
      observation.state,
    );
    if (
      isKnown &&
      (typeof observation.value !== "number" ||
        !Number.isFinite(observation.value) ||
        observation.value < 0 ||
        observation.value > 100)
    ) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "Known polishing percentage must be a number from 0 to 100",
      });
    }
  },
);

const vintageSchema = z.discriminatedUnion("state", [
  z
    .object({
      state: z.literal("known"),
      year: z.number().int().min(1800).max(2100),
    })
    .strict(),
  z.object({ state: z.literal("unknown"), year: z.null() }).strict(),
  z.object({ state: z.literal("not_applicable"), year: z.null() }).strict(),
]);

const identityObservationKeys = [
  "producer",
  "productName",
  "aliases",
  "cuvee",
  "vintage",
  "volumeMl",
  "packQuantity",
  "marketVariant",
  "barcode",
  "abvPercent",
] as const;
const observationMapSchema = z.partialRecord(
  z.enum(identityObservationKeys),
  fieldObservationSchema,
);

const categorySchemas = {
  wine: z
    .object({
      appellation: fieldObservationSchema.optional(),
      grapeVarieties: fieldObservationSchema.optional(),
      fermentation: fieldObservationSchema.optional(),
      maturation: fieldObservationSchema.optional(),
    })
    .strict(),
  spirits: z
    .object({
      spiritType: fieldObservationSchema.optional(),
      ageYears: fieldObservationSchema.optional(),
      caskType: fieldObservationSchema.optional(),
      batch: fieldObservationSchema.optional(),
    })
    .strict(),
  sake: z
    .object({
      brewery: fieldObservationSchema.optional(),
      grade: fieldObservationSchema.optional(),
      riceVariety: fieldObservationSchema.optional(),
      polishingPercent: polishingPercentObservationSchema.optional(),
      brewingYear: fieldObservationSchema.optional(),
    })
    .strict(),
} as const;

const identityBase = {
  schemaVersion: z.literal(1),
  producer: z.string().min(1).nullable(),
  productName: z.string().min(1).nullable(),
  aliases: z.array(z.string().min(1)),
  cuvee: z.string().min(1).nullable(),
  vintage: vintageSchema,
  volumeMl: finiteNumberSchema.positive().nullable(),
  packQuantity: finiteNumberSchema.int().positive().nullable(),
  marketVariant: z.string().min(1).nullable(),
  barcode: z.string().min(1).nullable(),
  abvPercent: finiteNumberSchema.min(0).max(100).nullable(),
  observations: observationMapSchema,
  status: z.enum(["candidate", "matched", "needs_confirmation"]),
} as const;

export const productIdentitySchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...identityBase,
        kind: z.literal("wine"),
        category: categorySchemas.wine,
      })
      .strict(),
    z
      .object({
        ...identityBase,
        kind: z.literal("spirits"),
        category: categorySchemas.spirits,
      })
      .strict(),
    z
      .object({
        ...identityBase,
        kind: z.literal("sake"),
        category: categorySchemas.sake,
      })
      .strict(),
  ])
  .superRefine((identity, context) => {
    const knownFields = [
      ["producer", identity.producer !== null],
      ["productName", identity.productName !== null],
      ["aliases", identity.aliases.length > 0],
      ["cuvee", identity.cuvee !== null],
      ["vintage", identity.vintage.state === "known"],
      ["volumeMl", identity.volumeMl !== null],
      ["packQuantity", identity.packQuantity !== null],
      ["marketVariant", identity.marketVariant !== null],
      ["barcode", identity.barcode !== null],
      ["abvPercent", identity.abvPercent !== null],
    ] as const;
    for (const [field, known] of knownFields) {
      const observation = identity.observations[field];
      if (known && (!observation || observation.evidenceIds.length === 0)) {
        context.addIssue({
          code: "custom",
          path: ["observations", field],
          message: `Known ${field} requires evidence`,
        });
        continue;
      }
      if (known && observation) {
        const expected =
          field === "vintage"
            ? identity.vintage.state === "known"
              ? identity.vintage.year
              : null
            : identity[field];
        if (JSON.stringify(observation.value) !== JSON.stringify(expected)) {
          context.addIssue({
            code: "custom",
            path: ["observations", field, "value"],
            message: `Observation for ${field} must match the identity value`,
          });
        }
      }
    }
    if (identity.kind === "sake") {
      const value = identity.category.polishingPercent?.value;
      if (typeof value === "number" && (value < 0 || value > 100)) {
        context.addIssue({
          code: "custom",
          path: ["category", "polishingPercent", "value"],
          message: "Expected 0-100",
        });
      }
    }
  });
export type ProductIdentity = z.infer<typeof productIdentitySchema>;

export const evidenceSourceSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.uuid(),
    kind: z.enum(["photo", "merchant", "web"]),
    assetId: z.uuid().nullable(),
    url: z.url().nullable(),
    title: z.string().min(1),
    domain: z.string().min(1).nullable(),
    capturedAt: z.iso.datetime({ offset: true }),
    excerpt: z.string(),
    location: z.string().min(1),
    documentDigest: z.string().min(1),
    contentScope: z.enum(["label", "note", "snippet", "document"]),
    truncated: z.boolean(),
    identity: productIdentitySchema.nullable(),
    trust: z.enum(["verified_official", "reliable", "unverified"]),
    independenceKey: z.string().min(1),
  })
  .strict()
  .superRefine((source, context) => {
    const valid =
      (source.kind === "photo" &&
        source.assetId !== null &&
        source.url === null &&
        source.domain === null) ||
      (source.kind === "merchant" &&
        source.assetId === null &&
        source.url === null &&
        source.domain === null) ||
      (source.kind === "web" &&
        source.assetId === null &&
        source.url !== null &&
        source.domain !== null);
    if (!valid)
      context.addIssue({
        code: "custom",
        message: "Evidence fields do not match source kind",
      });
    if (
      source.kind === "web" &&
      source.url &&
      !source.url.startsWith("https://")
    ) {
      context.addIssue({
        code: "custom",
        path: ["url"],
        message: "Web evidence requires HTTPS",
      });
    }
  });
export type EvidenceSource = z.infer<typeof evidenceSourceSchema>;

const claimFields = [
  ...identityObservationKeys,
  "appellation",
  "grapeVarieties",
  "fermentation",
  "maturation",
  "spiritType",
  "ageYears",
  "caskType",
  "batch",
  "brewery",
  "grade",
  "riceVariety",
  "polishingPercent",
  "brewingYear",
  "criticScores",
  "awards",
  "drinkingWindow",
  "selling_points",
  "introduction",
  "tasting",
  "pairing",
  "serving",
  "brand_background",
] as const;
export const supportedClaimSchema = z
  .object({
    id: z.uuid(),
    field: z.enum(claimFields),
    value: z.union([z.string(), finiteNumberSchema, z.array(z.string())]),
    kind: z.enum(["fact", "recommendation"]),
    scope: z.enum(["product", "brand"]),
    evidenceIds: z.array(evidenceIdSchema),
    premiseClaimIds: z.array(z.uuid()),
    state: z.enum(["accepted", "unknown", "conflict", "rejected"]),
    reason: z.string(),
  })
  .strict()
  .superRefine((claim, context) => {
    if (
      claim.state === "accepted" &&
      claim.kind === "fact" &&
      claim.evidenceIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message: "Accepted facts require evidence",
      });
    }
    if (
      claim.state === "accepted" &&
      claim.kind === "recommendation" &&
      claim.premiseClaimIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["premiseClaimIds"],
        message: "Accepted recommendations require premise claims",
      });
    }
  });
export type SupportedClaim = z.infer<typeof supportedClaimSchema>;

export const sectionKeySchema = z.enum([
  "selling_points",
  "introduction",
  "tasting",
  "pairing",
  "serving",
  "brand_background",
]);
export type SectionKey = z.infer<typeof sectionKeySchema>;
const localizedTextSchema = z
  .object({ en: z.string(), "zh-Hant": z.string() })
  .strict();
export const contentSectionSchema = z
  .object({
    key: sectionKeySchema,
    en: z.string(),
    "zh-Hant": z.string(),
    claimIds: z.array(z.uuid()),
    locked: z.boolean(),
    owner: z.enum(["automatic", "operator"]),
  })
  .strict();
export type ContentSection = z.infer<typeof contentSectionSchema>;
export const wineContentSchema = z
  .object({
    title: localizedTextSchema,
    sections: z.array(contentSectionSchema),
    seo: z
      .object({ title: localizedTextSchema, description: localizedTextSchema })
      .strict(),
    tags: z.array(z.string()),
  })
  .strict();
export type WineContent = z.infer<typeof wineContentSchema>;

export type WineStage =
  | "extraction"
  | "search_basic"
  | "verification"
  | "search_deep"
  | "verification_deep"
  | "generation"
  | "quality_check"
  | "commit_candidate";
export type WineMode = "full" | "research" | "copy" | "section";
export type QualityIssue = {
  path: string;
  code: string;
  blocking: boolean;
  evidenceIds: string[];
};
export type VerificationResult = {
  identity: ProductIdentity;
  claims: SupportedClaim[];
  needsDeepSearch: boolean;
  issues: QualityIssue[];
};
