import {
  ApiError,
  withRouteErrors,
  requireSessionContext,
} from "../route-support";
import { requireWorkspaceRole } from "../session-context";
import type { SessionContextPort } from "../session-context-port";
import {
  websiteStepResultSchema,
  type Database,
  type WebsiteCheckpoint,
  type WebsiteScan,
  type WebsiteStepResult,
} from "@wukong/db";
import type { WebsiteDocumentRequest } from "@wukong/jobs";
import { extractDocument } from "./extract-document";
import { isRobotsAllowed, parseRobots } from "./robots-policy";
import {
  createPublicFetch,
  type PublicDocument,
  type PublicFetch,
} from "./public-fetch";

export type WebsiteDatabase = Pick<Database, "forWorkspace">;
const root = (url: string) => new URL(url).origin + "/";
const unique = (urls: string[], limit: number) =>
  [...new Set(urls)].slice(0, limit);
const warn = (checkpoint: WebsiteCheckpoint, warnings: string[]) => {
  checkpoint.preview.warnings = unique(
    [...checkpoint.preview.warnings, ...warnings],
    30,
  );
};

/** Pure bounded checkpoint planner. The storage repository fences and validates the result. */
export function advanceWebsiteDocument(
  scan: WebsiteScan,
  document: PublicDocument | null,
  now: Date,
  failure?: string,
): WebsiteStepResult {
  const checkpoint = structuredClone(scan.checkpoint);
  const pending = checkpoint.pending!;
  checkpoint.pending = null;
  const result: WebsiteStepResult = {
    documentUrl: document?.url ?? null,
    state: "running",
    checkpoint,
  };
  const finish = (partial = false) => {
    checkpoint.pending = null;
    result.state = checkpoint.preview.products.length
      ? partial
        ? "partial"
        : "ready"
      : "failed";
    return websiteStepResultSchema.parse(result);
  };
  const schedule = (url: string, kind: "robots" | "discovery" | "product") => {
    checkpoint.pending = { url, kind };
    const delay = Math.max(1, checkpoint.robotsPolicy?.crawlDelaySeconds ?? 1);
    checkpoint.nextEligibleAt = new Date(
      Math.max(scan.nextEligibleAt.getTime(), now.getTime() + delay * 1000),
    ).toISOString();
    return websiteStepResultSchema.parse(result);
  };
  if (document?.redirectedTo) {
    if (now >= scan.deadlineAt) {
      warn(checkpoint, ["scan_deadline"]);
      return finish(true);
    }
    result.redirectedTo = document.redirectedTo;
    checkpoint.canonicalOrigin = root(document.redirectedTo);
    checkpoint.discoveryUrls = [];
    checkpoint.candidateUrls = [];
    checkpoint.visitedUrls = [];
    return schedule(
      new URL("robots.txt", checkpoint.canonicalOrigin).href,
      "robots",
    );
  }
  if (failure) warn(checkpoint, [failure]);
  if (pending.kind === "robots") {
    const policy = parseRobots({
      url: document?.url ?? pending.url,
      status: document?.status ?? 0,
      text: document?.text ?? "",
      contentType: document?.contentType,
      retryAfterSeconds: document?.retryAfterSeconds ?? undefined,
    });
    checkpoint.robotsPolicy = policy;
    warn(checkpoint, policy.warnings);
    if (
      document &&
      root(document.url) !== root(checkpoint.seedUrl) &&
      !checkpoint.canonicalOrigin
    ) {
      checkpoint.canonicalOrigin = root(document.url);
      checkpoint.discoveryUrls = [];
      checkpoint.candidateUrls = [];
      checkpoint.visitedUrls = [];
    }
    checkpoint.visitedUrls = unique(
      [...checkpoint.visitedUrls, document?.url ?? pending.url],
      31,
    );
    if (policy.state !== "ready") return finish(true);
    const origin = checkpoint.canonicalOrigin ?? root(checkpoint.seedUrl);
    const seed = new URL(
      new URL(checkpoint.seedUrl).pathname + new URL(checkpoint.seedUrl).search,
      origin,
    ).href;
    checkpoint.discoveryUrls = unique(
      [seed, ...policy.sitemapLinks.filter((url) => root(url) === origin)],
      5,
    );
    if (now >= scan.deadlineAt) {
      warn(checkpoint, ["scan_deadline"]);
      return finish(true);
    }
    if (isRobotsAllowed(policy, seed)) return schedule(seed, "discovery");
    warn(checkpoint, ["robots_disallowed"]);
  } else {
    const actual = document?.url ?? pending.url;
    if (document && !checkpoint.canonicalOrigin)
      checkpoint.canonicalOrigin = root(actual);
    if (document && checkpoint.robotsPolicy?.origin !== root(actual)) {
      checkpoint.discoveryUrls = [];
      checkpoint.candidateUrls = [];
      checkpoint.visitedUrls = [];
      if (now >= scan.deadlineAt) {
        warn(checkpoint, ["scan_deadline"]);
        return finish(true);
      }
      return schedule(new URL("robots.txt", root(actual)).href, "robots");
    }
    checkpoint.visitedUrls = unique(
      [...checkpoint.visitedUrls, pending.url, actual],
      31,
    );
    if (
      document &&
      document.status >= 200 &&
      document.status < 300 &&
      checkpoint.robotsPolicy &&
      isRobotsAllowed(checkpoint.robotsPolicy, actual)
    ) {
      const extracted = extractDocument({
        url: actual,
        capturedAt: document.capturedAt,
        html: document.text,
        contentType: document.contentType,
      });
      warn(checkpoint, extracted.warnings);
      const origin = checkpoint.canonicalOrigin!;
      const allowed = (url: string) =>
        root(url) === origin && isRobotsAllowed(checkpoint.robotsPolicy!, url);
      checkpoint.discoveryUrls = unique(
        [
          ...checkpoint.discoveryUrls,
          ...extracted.sitemapLinks.filter(allowed),
        ],
        5,
      );
      checkpoint.candidateUrls = unique(
        [
          ...checkpoint.candidateUrls,
          ...extracted.productLinks.filter(allowed),
        ],
        20,
      );
      if (extracted.product) {
        if (pending.kind === "product") {
          checkpoint.candidateUrls = unique(
            checkpoint.candidateUrls.map((url) =>
              url === pending.url ? actual : url,
            ),
            20,
          );
          if (
            !checkpoint.preview.products.some(
              (product) => product.key === extracted.product!.key,
            )
          )
            checkpoint.preview.products.push(extracted.product);
        } else if (
          checkpoint.candidateUrls.length < 20 ||
          checkpoint.candidateUrls.includes(actual)
        ) {
          checkpoint.candidateUrls = unique(
            [actual, ...checkpoint.candidateUrls],
            20,
          );
          if (now < scan.deadlineAt && scan.productRequests < 20)
            return schedule(actual, "product");
        }
      }
    } else
      warn(checkpoint, [
        document?.status === 429
          ? "website_rate_limited"
          : "document_unavailable",
      ]);
    if (document?.status === 429) return finish(true);
  }
  if (now >= scan.deadlineAt) {
    warn(checkpoint, ["scan_deadline"]);
    return finish(true);
  }
  const policy = checkpoint.robotsPolicy;
  if (policy?.state === "ready") {
    const candidate = checkpoint.candidateUrls.find(
      (url) =>
        !checkpoint.visitedUrls.includes(url) && isRobotsAllowed(policy, url),
    );
    if (candidate && scan.productRequests < 20)
      return schedule(candidate, "product");
    const discovery = checkpoint.discoveryUrls.find(
      (url) =>
        !checkpoint.visitedUrls.includes(url) && isRobotsAllowed(policy, url),
    );
    if (discovery && scan.discoveryRequests < 5)
      return schedule(discovery, "discovery");
    if (candidate || discovery) {
      warn(checkpoint, ["scan_budget_reached"]);
      return finish(true);
    }
  }
  return finish(
    checkpoint.preview.warnings.some((w) =>
      ["document_unavailable", "robots_disallowed"].includes(w),
    ),
  );
}

export function createWebsiteDocumentService(deps: {
  database: WebsiteDatabase;
  publicFetch?: PublicFetch;
  now?: () => Date;
}) {
  const fetchDocument = deps.publicFetch ?? createPublicFetch();
  const now = deps.now ?? (() => new Date());
  return async (input: WebsiteDocumentRequest) => {
    const claim = await deps.database.forWorkspace(
      input.workspaceId,
      (repositories) =>
        repositories.websiteCatalog.beginDocumentFetch({
          ...input,
          now: now(),
        }),
    );
    if (claim.status !== "claimed") return claim;
    // forWorkspace has resolved: its transaction is committed before any network request.
    const { scan, step } = claim;
    let document: PublicDocument | null = null;
    let failure: string | undefined;
    if (
      step.kind !== "robots" &&
      (!scan.checkpoint.robotsPolicy ||
        !isRobotsAllowed(scan.checkpoint.robotsPolicy, step.url))
    )
      failure = "robots_disallowed";
    else {
      try {
        document = await fetchDocument({
          url: step.url,
          kind: step.kind,
          lockedOrigin: step.lockedOrigin,
          signal: AbortSignal.timeout(10_000),
          approveUrl:
            step.kind === "robots"
              ? undefined
              : (url) => isRobotsAllowed(scan.checkpoint.robotsPolicy!, url),
        });
      } catch {
        failure = "document_unavailable";
      }
    }
    const completedAt = now();
    const result = advanceWebsiteDocument(scan, document, completedAt, failure);
    await deps.database.forWorkspace(input.workspaceId, (repositories) =>
      repositories.websiteCatalog.completeStep({
        ...input,
        now: completedAt,
        observation: result,
      }),
    );
    return { status: "completed" as const, result };
  };
}

export async function websiteRoute(
  work: () => Promise<Response>,
): Promise<Response> {
  const response = await withRouteErrors(work);
  response.headers.set("cache-control", "no-store");
  return response;
}
export async function websiteSession(session: SessionContextPort) {
  const context = await requireSessionContext(session);
  if (!requireWorkspaceRole("operator", context.role))
    throw new ApiError(403, "forbidden", "Operator access is required.");
  return context;
}
export async function readWebsiteBody(
  request: Request,
  maxBytes = 4096,
): Promise<string> {
  if (
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() !== "application/json"
  )
    throw new ApiError(415, "unsupported_media_type", "JSON is required.");
  if (Number(request.headers.get("content-length")) > maxBytes)
    throw new ApiError(413, "body_too_large", "Request body is too large.");
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      throw new ApiError(413, "body_too_large", "Request body is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch {
    throw new ApiError(400, "invalid_request", "Request body is invalid.");
  }
}
export function publicWebsiteScan(scan: WebsiteScan) {
  return {
    id: scan.id,
    state: scan.state,
    sourceUrl: scan.requestedUrl,
    capturedAt: scan.updatedAt.toISOString(),
    products: scan.checkpoint.preview.products,
    warnings:
      scan.dispatchStatus === "failed" &&
      ["queued", "running"].includes(scan.state)
        ? unique(
            [
              ...scan.checkpoint.preview.warnings.slice(0, 29),
              "website_scan_unavailable",
            ],
            30,
          )
        : scan.checkpoint.preview.warnings,
    progress: {
      scanned: scan.productRequests,
      selectedCandidates: scan.checkpoint.candidateUrls.length,
    },
  };
}

export function websiteMethodNotAllowed(allow: "GET" | "POST") {
  return Response.json(
    { code: "method_not_allowed", message: `${allow} is required.` },
    { status: 405, headers: { "cache-control": "no-store", allow } },
  );
}
