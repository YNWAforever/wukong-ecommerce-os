import { createHash } from "node:crypto";
import { MAX_ASSET_SIZE } from "./media-policy.js";
export type WineImageSnapshotInput = {
  workspaceId: string;
  runId: string;
  assetId: string;
  expectedDigest: string;
  bytes: Uint8Array;
  mimeType: string;
};
export type WineImageSnapshot = { bytes: Uint8Array; readUrl: string };
export function wineImageSnapshotKey(input: WineImageSnapshotInput): string {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  if (
    !/^[A-Za-z0-9_-]+$/.test(input.workspaceId) ||
    !uuid.test(input.runId) ||
    !uuid.test(input.assetId) ||
    !/^[0-9a-f]{64}$/.test(input.expectedDigest) ||
    !["image/jpeg", "image/png", "image/webp"].includes(input.mimeType)
  )
    throw Error("wine_snapshot_binding_invalid");
  verifyWineSnapshotBytes(input.bytes, input.expectedDigest);
  return `ws/${input.workspaceId}/wine-snapshots/${input.runId}/${input.assetId}/${input.expectedDigest}`;
}
export function verifyWineSnapshotBytes(bytes: Uint8Array, digest: string) {
  if (
    !bytes.byteLength ||
    bytes.byteLength > MAX_ASSET_SIZE ||
    createHash("sha256").update(bytes).digest("hex") !== digest
  )
    throw Error("wine_snapshot_digest_invalid");
}
