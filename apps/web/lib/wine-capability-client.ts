import {
  signQueueRequest,
  wineCapabilitySchema,
  type WineCapability,
} from "@wukong/jobs";
import { z } from "zod";
import type { WineMode } from "@wukong/core";

if (typeof window !== "undefined")
  throw new Error("Wine capability client is server-only");

const TIMEOUT_MS = 5000;
const MAX_BYTES = 32768;
const RECEIPT_TTL_MS = 30000;
type Config = Readonly<{
  QUEUE_INGRESS_URL?: string;
  QUEUE_INGRESS_SECRET?: string;
}>;
type ClockOptions = { env?: Config; now?: () => number; mode?: WineMode };
export type WineCapabilityClientOptions = ClockOptions & {
  fetch?: typeof globalThis.fetch;
};
declare const receiptBrand: unique symbol;
export type WineCapabilityReceipt = { readonly [receiptBrand]: true };
export type WineCapabilitySnapshot = Readonly<{
  schemaVersion: 1;
  mode: WineMode;
  origin: string;
  checkedAt: number;
  expiresAt: number;
  capability: WineCapability;
}>;
const receipts = new WeakMap<WineCapabilityReceipt, WineCapabilitySnapshot>();

function config(env: Config) {
  const secret = env.QUEUE_INGRESS_SECRET?.trim();
  try {
    const url = new URL(env.QUEUE_INGRESS_URL?.trim() ?? "");
    if (
      !secret ||
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error();
    return { origin: url.origin, secret };
  } catch {
    throw new Error("wine_capability_configuration");
  }
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function ready(capability: WineCapability, mode: WineMode) {
  return (
    capability.consumerSupported &&
    capability.goConfigured &&
    (mode === "copy" || mode === "section" || capability.tavilyConfigured) &&
    capability.queueReady &&
    capability.databaseReady &&
    capability.buildSha !== "unknown"
  );
}
/** Call outside all database transactions. No browser payload or provider credentials. */
export async function preflightWineCapability(
  options: WineCapabilityClientOptions = {},
): Promise<WineCapabilityReceipt> {
  const { origin, secret } = config(
    options.env ?? {
      QUEUE_INGRESS_URL: process.env.QUEUE_INGRESS_URL,
      QUEUE_INGRESS_SECRET: process.env.QUEUE_INGRESS_SECRET,
    },
  );
  const mode = z
    .enum(["full", "research", "copy", "section"])
    .parse(options.mode ?? "full");
  const now = options.now ?? Date.now;
  const body = "{}";
  const timestamp = Math.floor(now() / 1000);
  const signature = await signQueueRequest({
    secret,
    timestamp,
    path: "/health",
    body,
  });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        void reader?.cancel().catch(() => undefined);
        reject(new Error("wine_capability_unavailable"));
      }, TIMEOUT_MS);
    });
    const read = async () => {
      const response = await (options.fetch ?? globalThis.fetch)(
        new URL("/health", origin),
        {
          method: "POST",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "x-wukong-timestamp": String(timestamp),
            "x-wukong-signature": signature,
          },
          body,
        },
      );
      if (
        !response.ok ||
        response.redirected ||
        (response.url && response.url !== new URL("/health", origin).href)
      )
        throw new Error();
      if (
        Number(response.headers.get("content-length")) > MAX_BYTES ||
        !response.body
      )
        throw new Error();
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_BYTES) throw new Error();
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      const result = z
        .object({ authenticated: z.literal(true), wine: wineCapabilitySchema })
        .parse(
          JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        );
      if (!ready(result.wine, mode)) throw new Error();
      return result.wine;
    };
    const capability = await Promise.race([read(), deadline]);
    const checkedAt = now();
    if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) throw new Error();
    const receipt = Object.freeze({}) as WineCapabilityReceipt;
    receipts.set(
      receipt,
      freeze({
        schemaVersion: 1,
        mode,
        origin,
        checkedAt,
        expiresAt: checkedAt + RECEIPT_TTL_MS,
        capability,
      }),
    );
    return receipt;
  } catch {
    throw new Error("wine_capability_unavailable");
  } finally {
    clearTimeout(timer);
    controller.abort();
    void reader?.cancel().catch(() => undefined);
  }
}
/** Recheck after lock waits and before acceptance. Returns immutable persisted evidence.
 * JSON, copies, stale receipts and receipts for a different configured origin fail closed. */
export function requireWineCapabilityReceipt(
  receipt: WineCapabilityReceipt,
  options: ClockOptions = {},
): WineCapabilitySnapshot {
  const snapshot = receipts.get(receipt);
  if (!snapshot || snapshot.mode !== (options.mode ?? "full"))
    throw new Error("wine_capability_required");
  const { origin } = config(
    options.env ?? {
      QUEUE_INGRESS_URL: process.env.QUEUE_INGRESS_URL,
      QUEUE_INGRESS_SECRET: process.env.QUEUE_INGRESS_SECRET,
    },
  );
  const now = (options.now ?? Date.now)();
  if (
    !Number.isSafeInteger(now) ||
    now < snapshot.checkedAt ||
    now >= snapshot.expiresAt ||
    origin !== snapshot.origin
  )
    throw new Error("wine_capability_stale");
  return snapshot;
}
