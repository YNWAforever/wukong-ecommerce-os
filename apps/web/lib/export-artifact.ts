import { createHash } from "node:crypto";
import {
  AssetObjectMissingError,
  BULK_FORM_XLSX_MIME_TYPE,
  createExportAssetKey,
  type AssetStore,
} from "@wukong/assets";
export function artifactHash(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}
export class ExportArtifactConflict extends Error {
  constructor(
    readonly code: "artifact_hash_mismatch" | "artifact_candidate_mismatch",
  ) {
    super("The export bytes do not match the committed artifact identity.");
  }
}
/** Recover only the exact committed candidate; never replace an existing object. */
export async function ensureExportArtifact(
  input: {
    workspaceId: string;
    id: string;
    artifactSha256: string;
    body: Uint8Array;
  },
  store: Pick<AssetStore, "readObject" | "writeObjectIfAbsent">,
): Promise<void> {
  if (artifactHash(input.body) !== input.artifactSha256)
    throw new ExportArtifactConflict("artifact_candidate_mismatch");
  const key = createExportAssetKey({
    workspaceId: input.workspaceId,
    exportAttemptId: input.id,
    fileName: `export-${input.id}.xlsx`,
  });
  let bytes: Uint8Array;
  try {
    bytes = await store.readObject(input.workspaceId, key);
  } catch (error) {
    if (!(error instanceof AssetObjectMissingError)) throw error;
    await store.writeObjectIfAbsent(
      input.workspaceId,
      key,
      input.body,
      BULK_FORM_XLSX_MIME_TYPE,
    );
    bytes = await store.readObject(input.workspaceId, key);
  }
  if (artifactHash(bytes) !== input.artifactSha256)
    throw new ExportArtifactConflict("artifact_hash_mismatch");
}
