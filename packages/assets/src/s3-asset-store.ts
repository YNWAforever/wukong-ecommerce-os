import { MAX_ASSET_SIZE } from "./media-policy.js";
import {
  wineImageSnapshotKey,
  verifyWineSnapshotBytes,
  type WineImageSnapshotInput,
  type WineImageSnapshot,
} from "./wine-image-snapshot.js";
import {
  GetObjectCommand,
  HeadObjectCommand,
  NotFound,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import {
  ASSET_UPLOAD_TTL_MS,
  AssetObjectMissingError,
  assertAnyAssetKey,
  assertAssetKey,
  createAssetKey,
  type AssetObjectMetadata,
  type AssetStore,
  type CreateUploadInput,
} from "./asset-store.js";

export type S3Command = { input?: unknown };
export type S3Transport = {
  send(command: S3Command): Promise<unknown>;
};
export type S3Presigner = (
  transport: S3Transport,
  command: S3Command,
  options: { expiresIn: number },
) => Promise<string>;

export type S3AssetStoreOptions = {
  bucket: string;
  transport: S3Transport;
  presign?: S3Presigner;
  now?: () => Date;
};

const TEN_MINUTES_SECONDS = ASSET_UPLOAD_TTL_MS / 1000;
type SignedUrlClient = Parameters<typeof getSignedUrl>[0];
type SignedUrlCommand = Parameters<typeof getSignedUrl>[1];

const defaultPresigner: S3Presigner = (transport, command, options) =>
  getSignedUrl(
    transport as unknown as SignedUrlClient,
    command as unknown as SignedUrlCommand,
    options,
  );

export class S3AssetStore implements AssetStore {
  readonly #bucket: string;
  readonly #transport: S3Transport;
  readonly #presign: S3Presigner;
  readonly #now: () => Date;

  constructor(options: S3AssetStoreOptions) {
    if (!options.bucket.trim()) {
      throw new Error("S3 bucket is required");
    }
    this.#bucket = options.bucket;
    this.#transport = options.transport;
    this.#presign = options.presign ?? defaultPresigner;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * `requestChecksumCalculation` is pinned to `WHEN_REQUIRED` on purpose.
   *
   * The SDK default is `WHEN_SUPPORTED`, which computes a request checksum and,
   * when presigning, signs it into the URL as `x-amz-checksum-crc32`. A presign
   * has no body, so that value is always the CRC32 of zero bytes --
   * `AAAAAA==` -- baked into a URL the browser then PUTs real file bytes to.
   * Backends differ in whether they enforce it, which is exactly what makes it
   * dangerous: it works until a storage backend checks, and then every upload
   * fails at once with a checksum mismatch nobody changed.
   *
   * `WHEN_REQUIRED` omits it unless the operation genuinely demands one, so the
   * signature covers only what the client can actually honour. This does not
   * weaken integrity: the upload is still bounded by a signed `ContentLength`
   * and `ContentType`, and finalize re-reads the stored object.
   *
   * An explicit caller value still wins, so a deployment that needs a different
   * policy can set one.
   */
  static fromConfig(bucket: string, config: S3ClientConfig = {}): S3AssetStore {
    return new S3AssetStore({
      bucket,
      transport: new S3Client({
        requestChecksumCalculation: "WHEN_REQUIRED",
        ...config,
      }) as S3Transport,
    });
  }

  /** Server-only write-once namespace. Never issue an upload credential for this key. */
  async createWineImageSnapshot(
    input: WineImageSnapshotInput,
  ): Promise<WineImageSnapshot> {
    const key = wineImageSnapshotKey(input);
    try {
      await this.#transport.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: new Uint8Array(input.bytes),
          ContentType: input.mimeType,
          ContentLength: input.bytes.byteLength,
          IfNoneMatch: "*",
        }) as S3Command,
      );
    } catch (error) {
      if (httpStatus(error) !== 412) throw error;
    }
    const response = (await this.#transport.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }) as S3Command,
    )) as { Body?: S3Body };
    if (!response.Body) throw new AssetObjectMissingError();
    const bytes = await readBody(response.Body, MAX_ASSET_SIZE);
    verifyWineSnapshotBytes(bytes, input.expectedDigest);
    const readUrl = await this.#presign(
      this.#transport,
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }) as S3Command,
      { expiresIn: TEN_MINUTES_SECONDS },
    );
    if (new URL(readUrl).protocol !== "https:")
      throw Error("wine_snapshot_https_required");
    return { bytes, readUrl };
  }

  async createUpload(input: CreateUploadInput) {
    const key = createAssetKey(input);
    const command = new PutObjectCommand({
      Bucket: this.#bucket,
      Key: key,
      ContentLength: input.size,
      ContentType: input.mimeType,
    }) as unknown as S3Command;
    const uploadUrl = await this.#presign(this.#transport, command, {
      expiresIn: TEN_MINUTES_SECONDS,
    });
    return {
      key,
      uploadUrl,
      expiresAt: new Date(this.#now().getTime() + ASSET_UPLOAD_TTL_MS),
    };
  }

  async createReadUrl(
    workspaceId: string,
    key: string,
    options?: { expiresInMs?: number },
  ) {
    assertAssetKey(workspaceId, key);
    const lifetimeMs = options?.expiresInMs ?? ASSET_UPLOAD_TTL_MS;
    const command = new GetObjectCommand({
      Bucket: this.#bucket,
      Key: key,
    }) as unknown as S3Command;
    const url = await this.#presign(this.#transport, command, {
      expiresIn: lifetimeMs / 1000,
    });
    return {
      url,
      expiresAt: new Date(this.#now().getTime() + lifetimeMs),
    };
  }

  async head(workspaceId: string, key: string) {
    assertAssetKey(workspaceId, key);
    try {
      const response = (await this.#transport.send(
        new HeadObjectCommand({
          Bucket: this.#bucket,
          Key: key,
        }) as unknown as S3Command,
      )) as { ContentLength?: number; ContentType?: string };
      if (
        response.ContentLength === undefined ||
        response.ContentType === undefined
      ) {
        throw new Error("Object metadata is incomplete");
      }
      return { size: response.ContentLength, mimeType: response.ContentType };
    } catch (error) {
      if (
        error instanceof NotFound ||
        (typeof error === "object" &&
          error !== null &&
          "$metadata" in error &&
          (error as { $metadata?: { httpStatusCode?: number } }).$metadata
            ?.httpStatusCode === 404)
      ) {
        return null;
      }
      throw error;
    }
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
    assertAnyAssetKey(workspaceId, key);
    await this.#transport.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: body,
        ContentType: mimeType,
        ContentLength: body.byteLength,
      }) as unknown as S3Command,
    );
    return { size: body.byteLength, mimeType };
  }

  async writeObjectIfAbsent(
    workspaceId: string,
    key: string,
    body: Uint8Array,
    mimeType: string,
  ): Promise<boolean> {
    assertAnyAssetKey(workspaceId, key);
    try {
      await this.#transport.send(
        new PutObjectCommand({
          Bucket: this.#bucket,
          Key: key,
          Body: body,
          ContentType: mimeType,
          ContentLength: body.byteLength,
          IfNoneMatch: "*",
        }) as unknown as S3Command,
      );
      return true;
    } catch (error) {
      if (httpStatus(error) === 412) return false;
      throw error;
    }
  }

  async readObject(
    workspaceId: string,
    key: string,
    options?: { maxBytes: number },
  ): Promise<Uint8Array> {
    assertAnyAssetKey(workspaceId, key);
    try {
      const response = (await this.#transport.send(
        new GetObjectCommand({
          Bucket: this.#bucket,
          Key: key,
        }) as unknown as S3Command,
      )) as { Body?: S3Body };
      if (!response.Body) throw new AssetObjectMissingError();
      return await readBody(response.Body, options?.maxBytes);
    } catch (error) {
      if (httpStatus(error) === 404) throw new AssetObjectMissingError();
      throw error;
    }
  }
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("$metadata" in error))
    return undefined;
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata
    ?.httpStatusCode;
}

type S3Body = {
  transformToByteArray(): Promise<Uint8Array>;
  transformToWebStream?(): ReadableStream<Uint8Array>;
};
async function readBody(body: S3Body, maxBytes?: number): Promise<Uint8Array> {
  if (maxBytes === undefined) return body.transformToByteArray();
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    !body.transformToWebStream
  )
    throw Error("bounded_asset_stream_required");
  const reader = body.transformToWebStream().getReader(),
    chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw Error("asset_body_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
