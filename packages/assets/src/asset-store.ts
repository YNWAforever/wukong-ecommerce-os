import { randomUUID } from "node:crypto";

export const ASSET_UPLOAD_TTL_MS = 10 * 60 * 1000;
// Seven days is the SigV4 ceiling for a presigned URL. An exported CSV is carried
// to SHOPLINE by a person, so the ten-minute upload window does not apply to the
// image URLs inside it.
export const ASSET_EXPORT_READ_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_ASSET_SIZE = 20 * 1024 * 1024;

export const SUPPORTED_ASSET_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
] as const;

export type AssetMimeType = (typeof SUPPORTED_ASSET_MIME_TYPES)[number];

export type CreateUploadInput = {
  workspaceId: string;
  fileName: string;
  mimeType: AssetMimeType;
  size: number;
};

export type AssetObjectMetadata = {
  size: number;
  mimeType: string;
};

export class AssetInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AssetInputError";
  }
}

export interface AssetStore {
  createUpload(input: CreateUploadInput): Promise<{
    key: string;
    uploadUrl: string;
    expiresAt: Date;
  }>;
  createReadUrl(
    workspaceId: string,
    key: string,
    options?: { expiresInMs?: number },
  ): Promise<{ url: string; expiresAt: Date }>;
  head(workspaceId: string, key: string): Promise<AssetObjectMetadata | null>;
  exists(workspaceId: string, key: string): Promise<boolean>;
  writeObject(
    workspaceId: string,
    key: string,
    body: Uint8Array,
    mimeType: string,
  ): Promise<AssetObjectMetadata>;
  readObject(workspaceId: string, key: string): Promise<Uint8Array>;
}

export function assertWorkspaceId(workspaceId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) {
    throw new AssetInputError("Invalid workspace ID");
  }
}

export function assertAssetKey(workspaceId: string, key: string): void {
  assertWorkspaceId(workspaceId);
  const prefix = `ws/${workspaceId}/sources/`;
  if (!key.startsWith(prefix) || key.includes("..") || key.includes("\\")) {
    throw new AssetInputError("Asset key does not belong to workspace");
  }
  const remainder = key.slice(prefix.length);
  const segments = remainder.split("/");
  if (
    segments.length !== 2 ||
    segments.some((segment) => segment.length === 0) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      segments[0] ?? "",
    )
  ) {
    throw new AssetInputError("Invalid asset key");
  }
  let canonicalFileName: string;
  try {
    canonicalFileName = safeFileName(segments[1] ?? "");
  } catch {
    throw new AssetInputError("Invalid asset key");
  }
  if (canonicalFileName !== segments[1]) {
    throw new AssetInputError("Invalid asset key");
  }
}

export function safeFileName(fileName: string): string {
  const trimmed = fileName.trim();
  if (
    !trimmed ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..")
  ) {
    throw new AssetInputError("Invalid file name");
  }
  const safe = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-");
  if (!safe || safe === "." || safe === "..") {
    throw new AssetInputError("Invalid file name");
  }
  return safe.slice(0, 255);
}

export function assertAssetInput(input: CreateUploadInput): void {
  assertWorkspaceId(input.workspaceId);
  safeFileName(input.fileName);
  if (!SUPPORTED_ASSET_MIME_TYPES.includes(input.mimeType)) {
    throw new AssetInputError("Unsupported MIME type");
  }
  if (
    !Number.isSafeInteger(input.size) ||
    input.size <= 0 ||
    input.size > MAX_ASSET_SIZE
  ) {
    throw new AssetInputError("File must be between 1 byte and 20 MB");
  }
}

export function createAssetKey(input: CreateUploadInput): string {
  assertAssetInput(input);
  return `ws/${input.workspaceId}/sources/${randomUUID()}/${safeFileName(input.fileName)}`;
}

export class MemoryAssetStore implements AssetStore {
  readonly #objects = new Map<
    string,
    { metadata: AssetObjectMetadata; body?: Uint8Array }
  >();

  async createUpload(input: CreateUploadInput) {
    const key = createAssetKey(input);
    return {
      key,
      uploadUrl: `memory://upload/${encodeURIComponent(key)}`,
      expiresAt: new Date(Date.now() + ASSET_UPLOAD_TTL_MS),
    };
  }

  async createReadUrl(
    workspaceId: string,
    key: string,
    options?: { expiresInMs?: number },
  ) {
    assertAssetKey(workspaceId, key);
    const lifetimeMs = options?.expiresInMs ?? ASSET_UPLOAD_TTL_MS;
    return {
      url: `memory://read/${encodeURIComponent(key)}`,
      expiresAt: new Date(Date.now() + lifetimeMs),
    };
  }

  async head(workspaceId: string, key: string) {
    assertAssetKey(workspaceId, key);
    return this.#objects.get(key)?.metadata ?? null;
  }

  async exists(workspaceId: string, key: string) {
    return (await this.head(workspaceId, key)) !== null;
  }

  async writeObject(
    workspaceId: string,
    key: string,
    body: Uint8Array,
    mimeType: string,
  ): Promise<AssetObjectMetadata> {
    assertAssetKey(workspaceId, key);
    const metadata: AssetObjectMetadata = { size: body.byteLength, mimeType };
    this.#objects.set(key, { metadata, body });
    return metadata;
  }

  async readObject(workspaceId: string, key: string): Promise<Uint8Array> {
    assertAssetKey(workspaceId, key);
    const entry = this.#objects.get(key);
    if (!entry?.body) {
      throw new Error("Asset object has no stored body");
    }
    return entry.body;
  }

  putObject(
    workspaceId: string,
    key: string,
    metadata: AssetObjectMetadata,
  ): void {
    assertAssetKey(workspaceId, key);
    this.#objects.set(key, { metadata });
  }
}
