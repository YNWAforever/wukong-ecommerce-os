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

  static fromConfig(bucket: string, config: S3ClientConfig = {}): S3AssetStore {
    return new S3AssetStore({
      bucket,
      transport: new S3Client(config) as S3Transport,
    });
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
    assertAssetKey(workspaceId, key);
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

  async readObject(workspaceId: string, key: string): Promise<Uint8Array> {
    assertAssetKey(workspaceId, key);
    const response = (await this.#transport.send(
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key,
      }) as unknown as S3Command,
    )) as {
      Body?: { transformToByteArray(): Promise<Uint8Array> };
    };
    if (!response.Body) {
      throw new Error("Asset object has no stored body");
    }
    return response.Body.transformToByteArray();
  }
}
