import { lookup } from "node:dns/promises";
import { Agent, request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import {
  checkServerIdentity,
  connect,
  type ConnectionOptions,
  type TLSSocket,
} from "node:tls";

export type DocumentKind = "robots" | "discovery" | "product";
export type PublicDocument = {
  url: string;
  status: number;
  contentType: string;
  text: string;
  capturedAt: string;
  retryAfterSeconds: number | null;
  /** Validated initial canonical redirect; target has not been fetched. */
  redirectedTo?: string;
};
export type PublicFetch = (input: {
  url: string;
  kind: DocumentKind;
  lockedOrigin: string | null;
  signal: AbortSignal;
  /** Server-owned persisted robots policy, checked before each requested hop. */
  approveUrl?: (url: string) => boolean;
}) => Promise<PublicDocument>;
export class PublicFetchError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PublicFetchError";
  }
}
export type PinnedTarget = {
  hostname: string;
  address: string;
  family: number;
  path: string;
  signal: AbortSignal;
};
export type DocumentResponse = {
  status: number;
  contentType: string;
  body: AsyncIterable<Uint8Array | string> | Iterable<Uint8Array | string>;
  location?: string;
  contentEncoding?: string;
  retryAfter?: string;
  cancel?: () => void;
};
export type PublicFetchDeps = {
  resolve?: (
    hostname: string,
  ) => Promise<{ address: string; family: number }[]>;
  request?: (target: PinnedTarget) => Promise<DocumentResponse>;
  /** Socket factory for isolated transport tests. The production default is direct node:tls. */
  dial?: (options: ConnectionOptions & { family: number }) => TLSSocket;
  now?: () => Date;
};
const fail = (code: string): never => {
  throw new PublicFetchError(code);
};

/** Conservative global-unicast policy: also exclude transition and documentation ranges. */
function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 &&
        (b === 168 ||
          (b === 0 && (c === 0 || c === 2)) ||
          (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(address) !== 6 || address.includes("%") || address.includes("."))
    return false;
  const halves = address.toLowerCase().split("::");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const words = [
    ...left,
    ...Array(8 - left.length - right.length).fill("0"),
    ...right,
  ].map((word) => parseInt(word, 16));
  const a = words[0] ?? 0,
    b = words[1] ?? 0;
  return (
    a >= 0x2000 &&
    a <= 0x3fff &&
    !(a === 0x2001 && (b < 0x0200 || b === 0x0db8)) &&
    a !== 0x2002 &&
    !(a === 0x3fff && b < 0x1000)
  );
}
function normalize(raw: string): URL {
  if (raw !== raw.trim() || /[\\\s]/.test(raw)) fail("invalid_url");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return fail("invalid_url");
  }
  const authority = /^https:\/\/([^/?#]*)/i.exec(raw)?.[1] ?? "";
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    authority.includes("@") ||
    (url.port && url.port !== "443")
  )
    fail("invalid_url");
  const rawHost = authority.startsWith("[")
    ? authority.slice(1, authority.indexOf("]"))
    : (authority.split(":")[0] ?? "");
  const hostname = url.hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "")
    .toLowerCase();
  if (isIP(hostname)) {
    if (isIP(hostname) === 4 && rawHost !== hostname) fail("invalid_url");
    if (!publicAddress(hostname)) fail("unsafe_address");
  } else if (
    !hostname.includes(".") ||
    /(?:^|\.)(?:localhost|local|internal|localdomain|lan|home|corp|intranet|onion|arpa|invalid)$/.test(
      hostname,
    )
  )
    fail("invalid_url");
  if (!isIP(hostname)) url.hostname = hostname;
  url.hash = "";
  return url;
}
function waitAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
function nodeRequest(
  dial: NonNullable<PublicFetchDeps["dial"]>,
): NonNullable<PublicFetchDeps["request"]> {
  return (target) =>
    new Promise((resolve, reject) => {
      // A per-document-hop direct agent prevents socket reuse and ambient global proxy agents.
      const agent = new Agent({
        keepAlive: false,
        maxSockets: 1,
        proxyEnv: { NODE_ENV: "production" },
      });
      agent.createConnection = () =>
        dial({
          host: target.address,
          port: 443,
          family: target.family,
          servername: isIP(target.hostname) ? undefined : target.hostname,
          rejectUnauthorized: true,
          checkServerIdentity: (_hostname, certificate) =>
            checkServerIdentity(target.hostname, certificate),
          ALPNProtocols: ["http/1.1"],
        });
      const req = httpsRequest(
        {
          hostname: target.hostname,
          port: 443,
          path: target.path,
          method: "GET",
          agent,
          signal: target.signal,
          headers: {
            Host:
              isIP(target.hostname) === 6
                ? `[${target.hostname}]`
                : target.hostname,
            "User-Agent": "WukongCatalogPreview/1.0",
            Accept:
              "text/html, application/xhtml+xml, application/xml, text/xml, text/plain",
            "Accept-Encoding": "identity",
            Connection: "close",
          },
        },
        (response) => {
          const cancel = () => {
            response.destroy();
            req.destroy();
            agent.destroy();
          };
          response.once("close", () => agent.destroy());
          resolve({
            status: response.statusCode ?? 0,
            contentType: response.headers["content-type"] ?? "",
            contentEncoding: response.headers["content-encoding"],
            location: response.headers.location,
            retryAfter: response.headers["retry-after"],
            body: response,
            cancel,
          });
        },
      );
      req.once("error", (error) => {
        agent.destroy();
        reject(error);
      });
      req.end();
    });
}
function retryAfter(raw: string | undefined, now: Date): number | null {
  if (!raw) return null;
  const seconds = /^\d+$/.test(raw)
    ? Number(raw)
    : (Date.parse(raw) - now.getTime()) / 1000;
  return Number.isFinite(seconds) ? Math.max(0, Math.ceil(seconds)) : null;
}

export function createPublicFetch(deps: PublicFetchDeps = {}): PublicFetch {
  const resolve =
    deps.resolve ??
    ((hostname) => lookup(hostname, { all: true, verbatim: true }));
  const request = deps.request ?? nodeRequest(deps.dial ?? connect);
  const now = deps.now ?? (() => new Date());
  return async (input) => {
    const controller = new AbortController();
    const abort = () => controller.abort(new PublicFetchError("aborted"));
    input.signal.addEventListener("abort", abort, { once: true });
    if (input.signal.aborted) abort();
    const timer = setTimeout(
      () => controller.abort(new PublicFetchError("deadline_exceeded")),
      10_000,
    );
    const signal = controller.signal;
    let response: DocumentResponse | undefined;
    try {
      let url = normalize(input.url);
      let origin =
        input.lockedOrigin === null
          ? url.origin
          : normalize(input.lockedOrigin).origin;
      if (url.origin !== origin) fail("origin_mismatch");
      let canonicalized = input.lockedOrigin !== null;
      for (let redirects = 0; ; redirects++) {
        signal.throwIfAborted();
        if (input.approveUrl && !input.approveUrl(url.href))
          fail("robots_disallowed");
        const hostname = url.hostname.replace(/^\[|\]$/g, "");
        const addresses = isIP(hostname)
          ? [{ address: hostname, family: isIP(hostname) }]
          : await waitAbort(resolve(hostname), signal);
        if (
          !addresses.length ||
          addresses.some(
            (answer) =>
              !publicAddress(answer.address) ||
              isIP(answer.address) !== answer.family,
          )
        )
          fail("unsafe_address");
        const address = addresses[0]!;
        // Dispose even a late adapter response if the total deadline won the race.
        const pending = request({
          hostname,
          ...address,
          path: url.pathname + url.search,
          signal,
        });
        pending.then(
          (result) => {
            if (signal.aborted) result.cancel?.();
          },
          () => {},
        );
        response = await waitAbort(pending, signal);
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          response.cancel?.();
          if (redirects >= 3) fail("too_many_redirects");
          if (!response.location) fail("invalid_redirect");
          let next: URL;
          try {
            const location = response.location!;
            if (location !== location.trim() || /[\\\s]/.test(location))
              fail("invalid_url");
            next = normalize(
              /^[a-z][a-z0-9+.-]*:/i.test(location)
                ? location
                : location.startsWith("//")
                  ? `https:${location}`
                  : new URL(location, url).href,
            );
          } catch (error) {
            if (error instanceof PublicFetchError) throw error;
            return fail("invalid_redirect");
          }
          if (next.origin !== origin) {
            const apex = (value: string) => value.replace(/^www\./, "");
            if (
              canonicalized ||
              input.kind === "product" ||
              apex(next.hostname) !== apex(url.hostname) ||
              next.hostname === url.hostname
            )
              fail("origin_mismatch");
            if (input.kind === "discovery") {
              return {
                url: url.href,
                redirectedTo: next.href,
                status: response.status,
                contentType: response.contentType,
                text: "",
                capturedAt: now().toISOString(),
                retryAfterSeconds: null,
              };
            }
            origin = next.origin;
            canonicalized = true;
          }
          url = next;
          continue;
        }
        const contentType = response.contentType
          .split(";")[0]!
          .trim()
          .toLowerCase();
        if (response.status < 200 || response.status >= 300) {
          const capturedAt = now();
          return {
            url: url.href,
            status: response.status,
            contentType,
            text: "",
            capturedAt: capturedAt.toISOString(),
            retryAfterSeconds: retryAfter(response.retryAfter, capturedAt),
          };
        }
        const allowed =
          input.kind === "product"
            ? ["text/html", "application/xhtml+xml"]
            : input.kind === "robots"
              ? ["text/plain", "text/html"]
              : [
                  "text/html",
                  "application/xhtml+xml",
                  "application/xml",
                  "text/xml",
                  "text/plain",
                ];
        if (!allowed.includes(contentType)) fail("unsupported_content_type");
        if (
          response.contentEncoding &&
          response.contentEncoding.trim().toLowerCase() !== "identity"
        )
          fail("unsupported_encoding");
        const limit =
          input.kind === "robots" ||
          !["text/html", "application/xhtml+xml"].includes(contentType)
            ? 1024 * 1024
            : 2 * 1024 * 1024;
        const chunks: Buffer[] = [];
        let size = 0;
        const body = response.body;
        const iterator =
          Symbol.asyncIterator in body
            ? body[Symbol.asyncIterator]()
            : body[Symbol.iterator]();
        while (true) {
          const chunk = await waitAbort(
            Promise.resolve(iterator.next()),
            signal,
          );
          if (chunk.done) break;
          const bytes = Buffer.from(chunk.value);
          size += bytes.byteLength;
          if (size > limit) fail("body_too_large");
          chunks.push(bytes);
        }
        const capturedAt = now();
        return {
          url: url.href,
          status: response.status,
          contentType,
          text: Buffer.concat(chunks).toString("utf8"),
          capturedAt: capturedAt.toISOString(),
          retryAfterSeconds: retryAfter(response.retryAfter, capturedAt),
        };
      }
    } catch (error) {
      if (signal.aborted) throw signal.reason;
      if (error instanceof PublicFetchError) throw error;
      throw new PublicFetchError("transport_failed");
    } finally {
      response?.cancel?.();
      clearTimeout(timer);
      input.signal.removeEventListener("abort", abort);
    }
  };
}
