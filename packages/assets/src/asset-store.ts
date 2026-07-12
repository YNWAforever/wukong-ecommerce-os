import { randomUUID } from "node:crypto";

export const ASSET_UPLOAD_TTL_MS = 10 * 60 * 1000;
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

export interface AssetStore {
  createUpload(input: CreateUploadInput): Promise<{
    key: string;
    uploadUrl: string;
    expiresAt: Date;
  }>;
  createReadUrl(
    workspaceId: string,
    key: string,
  ): Promise<{ url: string; expiresAt: Date }>;
  head(workspaceId: string, key: string): Promise<AssetObjectMetadata | null>;
  exists(workspaceId: string, key: string): Promise<boolean>;
}

export function assertWorkspaceId(workspaceId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(workspaceId)) {
    throw new Error("Invalid workspace ID");
  }
}

export function assertAssetKey(workspaceId: string, key: string): void {
  assertWorkspaceId(workspaceId);
  const prefix = `ws/${workspaceId}/sources/`;
  if (!key.startsWith(prefix) || key.includes("..") || key.includes("\\")) {
    throw new Error("Asset key does not belong to workspace");
  }
  const remainder = key.slice(prefix.length);
  const segments = remainder.split("/");
  if (
    segments.length !== 2 ||
    segments.some((segment) => segment.length === 0) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segments[0] ?? "")
  ) {
    throw new Error("Invalid asset key");
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
    throw new Error("Invalid file name");
  }
  const safe = trimmed.replace(/[^A-Za-z0-9._-]+/g, "-");
  if (!safe || safe === "." || safe === "..") {
    throw new Error("Invalid file name");
  }
  return safe.slice(0, 255);
}

export function assertAssetInput(input: CreateUploadInput): void {
  assertWorkspaceId(input.workspaceId);
  safeFileName(input.fileName);
  if (!SUPPORTED_ASSET_MIME_TYPES.includes(input.mimeType)) {
    throw new Error("Unsupported MIME type");
  }
  if (!Number.isSafeInteger(input.size) || input.size <= 0 || input.size > MAX_ASSET_SIZE) {
    throw new Error("File must be between 1 byte and 20 MB");
  }
}

export function createAssetKey(input: CreateUploadInput): string {
  assertAssetInput(input);
  return `ws/${input.workspaceId}/sources/${randomUUID()}/${safeFileName(input.fileName)}`;
}

export class MemoryAssetStore implements AssetStore {
  readonly #objects = new Map<string, AssetObjectMetadata>();

  async createUpload(input: CreateUploadInput) {
    const key = createAssetKey(input);
    return {
      key,
      uploadUrl: `memory://upload/${encodeURIComponent(key)}`,
      expiresAt: new Date(Date.now() + ASSET_UPLOAD_TTL_MS),
    };
  }

  async createReadUrl(workspaceId: string, key: string) {
    assertAssetKey(workspaceId, key);
    return {
      url: `memory://read/${encodeURIComponent(key)}`,
      expiresAt: new Date(Date.now() + ASSET_UPLOAD_TTL_MS),
    };
  }

  async head(workspaceId: string, key: string) {
    assertAssetKey(workspaceId, key);
    return this.#objects.get(key) ?? null;
  }

  async exists(workspaceId: string, key: string) {
    return (await this.head(workspaceId, key)) !== null;
  }

  putObject(workspaceId: string, key: string, metadata: AssetObjectMetadata): void {
    assertAssetKey(workspaceId, key);
    this.#objects.set(key, metadata);
  }
}
