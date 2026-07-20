import {
  LISTING_INGRESS_PATH,
  SHOPLINE_INGRESS_PATH,
  listingJobSchema,
  shoplinePublishJobSchema,
  verifyQueueRequest,
} from "@wukong/jobs";

import { workerHealth } from "./cloudflare-runtime.js";
import type { WorkerEnv } from "./worker-env.js";

const MAX_BODY_BYTES = 4 * 1024;

type IngressOptions = {
  nowSeconds?: () => number;
};

function response(status: number): Response {
  return new Response(null, { status });
}

async function readLimitedBody(request: Request): Promise<string | Response> {
  const declaredLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return response(413);
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteLength += value.byteLength;
    if (byteLength > MAX_BODY_BYTES) {
      await reader.cancel();
      return response(413);
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return response(400);
  }
}

export async function handleIngress(
  request: Request,
  env: WorkerEnv,
  _context?: ExecutionContext,
  options: IngressOptions = {},
): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path === "/health") {
    if (request.method !== "GET") return response(405);
    return Response.json(workerHealth(env));
  }
  if (path !== LISTING_INGRESS_PATH && path !== SHOPLINE_INGRESS_PATH) {
    return response(404);
  }
  if (request.method !== "POST") return response(405);
  if (
    request.headers
      .get("content-type")
      ?.toLowerCase()
      .split(";", 1)[0]
      ?.trim() !== "application/json"
  ) {
    return response(415);
  }

  const body = await readLimitedBody(request);
  if (body instanceof Response) return body;
  const secret = env.QUEUE_INGRESS_SECRET?.trim();
  const timestamp = request.headers.get("x-wukong-timestamp") ?? "";
  const signature = request.headers.get("x-wukong-signature") ?? "";
  if (!secret || !timestamp || !signature) return response(401);

  const authenticated = await verifyQueueRequest({
    secret,
    nowSeconds: (
      options.nowSeconds ?? (() => Math.floor(Date.now() / 1_000))
    )(),
    timestamp,
    signature,
    path,
    body,
  });
  if (!authenticated) return response(401);

  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return response(400);
  }

  if (path === LISTING_INGRESS_PATH) {
    const parsed = listingJobSchema.safeParse(input);
    if (!parsed.success) return response(400);
    if (typeof env.LISTING_QUEUE?.send !== "function") return response(503);
    await env.LISTING_QUEUE.send(parsed.data);
  } else {
    const parsed = shoplinePublishJobSchema.safeParse(input);
    if (!parsed.success) return response(400);
    if (typeof env.SHOPLINE_QUEUE?.send !== "function") return response(503);
    await env.SHOPLINE_QUEUE.send(parsed.data);
  }
  return response(202);
}
