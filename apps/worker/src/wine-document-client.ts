import {
  WINE_DOCUMENT_PATH,
  wineDocumentRequestSchema,
  wineDocumentResultSchema,
  signQueueRequest,
  type WineDocumentRequest,
  type WineDocumentResult,
} from "@wukong/jobs";
export function createWineDocumentClient(deps: {
  baseUrl: string;
  secret: string;
  fetch?: typeof fetch;
  now?: () => Date;
}) {
  const origin = new URL(deps.baseUrl);
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    !deps.secret.trim()
  )
    throw new Error("invalid wine callback configuration");
  const url = new URL(WINE_DOCUMENT_PATH, origin.origin).href;
  return async (raw: WineDocumentRequest): Promise<WineDocumentResult> => {
    const input = wineDocumentRequestSchema.parse(raw),
      body = JSON.stringify(input);
    const timestamp = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
    const signature = await signQueueRequest({
      secret: deps.secret,
      timestamp,
      path: WINE_DOCUMENT_PATH,
      body,
    });
    try {
      const response = await (deps.fetch ?? fetch)(url, {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: {
          "content-type": "application/json",
          "x-wukong-timestamp": String(timestamp),
          "x-wukong-signature": signature,
        },
        body,
      });
      const length = response.headers.get("content-length");
      if (
        !response.ok ||
        response.status !== 200 ||
        response.redirected ||
        (response.url && response.url !== url) ||
        (length !== null &&
          (!Number.isSafeInteger(Number(length)) ||
            Number(length) < 0 ||
            Number(length) > 131072))
      ) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("invalid callback");
      }
      if (!response.body) throw new Error("missing callback body");
      const reader = response.body.getReader(),
        chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 131072) {
          await reader.cancel().catch(() => undefined);
          throw new Error("oversized callback");
        }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      const parsed = JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      );
      if (
        parsed.status !== "completed" ||
        Object.keys(parsed).some((k) => !["status", "result"].includes(k))
      )
        throw new Error("invalid callback state");
      const result = wineDocumentResultSchema.parse(parsed.result);
      if (
        Object.entries(input).some(
          ([key, value]) => result[key as keyof WineDocumentRequest] !== value,
        )
      )
        throw new Error("callback binding mismatch");
      return result;
    } catch {
      throw new Error("wine_document_unavailable");
    }
  };
}
