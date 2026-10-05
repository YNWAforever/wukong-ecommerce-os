import { z } from "zod";
import { listingInputDigest } from "@wukong/db";
import { ApiError } from "./route-support";
const positionSchema = z
  .object({
    // Keep the database's six fractional digits; converting to Date loses ties.
    at: z
      .string()
      .regex(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/,
      )
      .refine((value) => Number.isFinite(Date.parse(value))),
    id: z.uuid(),
    tie: z.enum([
      "platform",
      "draft",
      "website",
      "workbook",
      "listing",
      "batch",
      "publish_job",
      "pipeline_run",
      "export",
      "import_result",
    ]),
    direction: z.enum(["next", "previous"]),
  })
  .strict();
export type ReadCursorPosition = z.infer<typeof positionSchema>;
type CursorScope = Record<string, string | number | null | undefined>;
function invalid(): never {
  throw new ApiError(
    400,
    "invalid_cursor",
    "The cursor does not match this workspace or query. Refresh the list.",
  );
}
export function encodeReadCursor(
  position:
    (Omit<ReadCursorPosition, "tie"> & { tie: string }) | null | undefined,
  scope: CursorScope,
): string | null {
  if (!position) return null;
  return Buffer.from(
    JSON.stringify({
      v: 1,
      scope: listingInputDigest(scope),
      position: positionSchema.parse(position),
    }),
  ).toString("base64url");
}
export function decodeReadCursor(
  token: string | null | undefined,
  scope: CursorScope,
): ReadCursorPosition | undefined {
  if (!token) return undefined;
  if (token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token)) invalid();
  let value: unknown;
  try {
    const bytes = Buffer.from(token, "base64url");
    if (bytes.toString("base64url") !== token) invalid();
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    invalid();
  }
  const parsed = z
    .object({
      v: z.literal(1),
      scope: z.literal(listingInputDigest(scope)),
      position: positionSchema,
    })
    .strict()
    .safeParse(value);
  if (!parsed.success) invalid();
  const view = scope.view ?? scope.kind;
  const ties =
    view === "catalog"
      ? ["platform", "draft", "website", "workbook"]
      : view === "listings"
        ? ["listing"]
        : view === "jobs"
          ? ["batch", "publish_job", "pipeline_run", "export", "import_result"]
          : [];
  if (!ties.includes(parsed.data.position.tie)) invalid();
  return parsed.data.position;
}
