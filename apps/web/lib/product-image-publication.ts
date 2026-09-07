import { createHash } from "node:crypto";
import { AssetObjectMissingError } from "@wukong/assets";
export type PublishedImage = {
  workspaceId: string;
  storageKey: string;
  digest: string;
  size: number;
};
export type PublishedImageDeps = {
  lookupPublishedImage(token: string): Promise<PublishedImage | null>;
  readObject(workspaceId: string, key: string): Promise<Uint8Array>;
};
const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};
const missing = () => new Response(null, { status: 404, headers });
export function createPublishedImageHandler(deps: PublishedImageDeps) {
  return async function publishedImage(
    request: Request,
    context: { params: Promise<{ file: string }> },
  ): Promise<Response> {
    const { file } = await context.params;
    if (!/^[A-Za-z0-9_-]{43}\.jpg$/.test(file)) return missing();
    const record = await deps.lookupPublishedImage(file.slice(0, -4));
    if (!record) return missing();
    let bytes: Uint8Array;
    try {
      bytes = await deps.readObject(record.workspaceId, record.storageKey);
    } catch (error) {
      if (error instanceof AssetObjectMissingError) return missing();
      throw error;
    }
    if (
      bytes.byteLength !== record.size ||
      createHash("sha256").update(bytes).digest("hex") !== record.digest
    )
      return missing();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    });
    return new Response(request.method === "HEAD" ? null : body, {
      headers: {
        ...headers,
        "content-type": "image/jpeg",
        "content-length": String(record.size),
      },
    });
  };
}
