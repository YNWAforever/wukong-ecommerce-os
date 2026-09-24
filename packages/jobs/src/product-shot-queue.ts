import { z } from "zod";
export const PRODUCT_SHOT_INGRESS_PATH = "/ingress/product-shots";
export const productShotJobSchema = z
  .object({
    kind: z.literal("product_shot"),
    workspaceId: z.string().min(1),
    draftId: z.string().uuid(),
    attemptId: z.string().uuid(),
  })
  .strict();
export type ProductShotJob = z.infer<typeof productShotJobSchema>;
