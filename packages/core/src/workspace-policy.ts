import { z } from "zod";

export const WORKSPACE_REQUIRED_FIELDS = [
  "sku",
  "producer",
  "productType",
  "country",
  "region",
  "vintage",
  "volumeMl",
  "abvPercent",
  "packQuantity",
  "priceHkd",
  "stockQuantity",
] as const;
export const sourcePreferencesSchema = z
  .object({
    allowedDomains: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .max(253)
          .regex(/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/),
      )
      .max(50),
  })
  .strict();
/** Commercial capability, credentials and paid admission are deliberately not editable here. */
export const workspacePolicySchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    tone: z.string().trim().min(1).max(2000),
    claimPolicy: z.array(z.string().trim().min(1).max(500)).max(30),
    requiredFields: z
      .array(z.enum(WORKSPACE_REQUIRED_FIELDS))
      .max(WORKSPACE_REQUIRED_FIELDS.length),
    sourcePreferences: sourcePreferencesSchema,
  })
  .strict();
export type WorkspacePolicy = z.infer<typeof workspacePolicySchema>;

export function missingWorkspaceFields(
  content: Record<string, unknown>,
  required: readonly string[],
): string[] {
  return required.filter(
    (field) =>
      !WORKSPACE_REQUIRED_FIELDS.includes(
        field as (typeof WORKSPACE_REQUIRED_FIELDS)[number],
      ) ||
      content[field] == null ||
      content[field] === "",
  );
}
