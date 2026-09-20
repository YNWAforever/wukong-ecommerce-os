import { setTimeout as pause } from "node:timers/promises";
import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterMap } from "parse5";
import type { EvidenceSource } from "@wukong/core";
import {
  WINE_DOCUMENT_TEXT_LIMIT,
  WINE_DOCUMENT_TRUNCATION_MARKER,
  wineDocumentRequestSchema,
  wineDocumentResultSchema,
  type WineDocumentRequest,
  type WineDocumentResult,
} from "@wukong/jobs";
import { createPublicFetch, type PublicFetch } from "./public-fetch";
import { parseRobots, isRobotsAllowed } from "./robots-policy";
import { extractDocument } from "./extract-document";
export type WineDocumentContext = {
  workspaceId: string;
  runId: string;
  source: EvidenceSource;
  inputRevision: number;
  currentInputRevision: number;
  currentRunId: string | null;
  flowVersion: string;
  executionState: string;
  acceptedAt: string;
  deadlineAt: string;
  allowedDomains: string[];
};
export type WineDocumentClaim =
  | { state: "stale" }
  | { state: "unknown" }
  | { state: "completed"; result: WineDocumentResult }
  | { state: "claimed"; context: WineDocumentContext };
/** Implementations must commit claims before returning. Claim atomically validates current run,
 * revision, deadline and source ownership; then returns its persisted policy/context. A duplicate
 * started claim is unknown; terminal output is immutable and returned only after the same guards.
 * finish atomically persists bounded output for that claim and rechecks the run/revision/deadline.
 * Neither method accepts a URL or model-supplied authority. */
export type WineDocumentStore = {
  claim(input: WineDocumentRequest, now: string): Promise<WineDocumentClaim>;
  finish(
    input: WineDocumentRequest,
    result: WineDocumentResult,
    now: string,
  ): Promise<boolean>;
};
export type WineDocumentOutcome =
  | { status: "stale" | "unknown" }
  | { status: "completed"; result: WineDocumentResult };
type Node = DefaultTreeAdapterMap["node"];
const digest = (text: string) =>
  "sha256:" + createHash("sha256").update(text).digest("hex");
function textOf(root: Node, preserveLines = false): string {
  const parts: string[] = [],
    pending: Array<Node | string> = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (typeof node === "string") {
      parts.push(node);
      continue;
    }
    if (
      "tagName" in node &&
      [
        "script",
        "style",
        "template",
        "noscript",
        "iframe",
        "object",
        "nav",
        "footer",
      ].includes(node.tagName)
    )
      continue;
    if (
      preserveLines &&
      "tagName" in node &&
      [
        "p",
        "div",
        "li",
        "tr",
        "article",
        "main",
        "section",
        "blockquote",
        "pre",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "br",
      ].includes(node.tagName)
    ) {
      parts.push("\n");
      pending.push("\n");
    }
    if ("value" in node) parts.push(node.value);
    if ("childNodes" in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--)
        pending.push(node.childNodes[i]!);
  }
  const text = parts.join(" ");
  return preserveLines
    ? text
        .split(/\r?\n/)
        .map((line) => line.replace(/\s+/g, " ").trim())
        .filter(Boolean)
        .join("\n")
    : text.replace(/\s+/g, " ").trim();
}
function article(html: string): {
  text: string;
  title: string;
  location: string;
} {
  const pending: Node[] = [parse(html)];
  let scope: Node | undefined,
    body: Node | undefined,
    title = "";
  while (pending.length) {
    const node = pending.pop()!;
    if ("tagName" in node) {
      if (node.tagName === "article" && !scope) scope = node;
      if (node.tagName === "main" && !body) body = node;
      if (node.tagName === "body" && !body) body = node;
      if (node.tagName === "title") title = textOf(node);
    }
    if ("childNodes" in node)
      for (let i = node.childNodes.length - 1; i >= 0; i--)
        pending.push(node.childNodes[i]!);
  }
  return {
    text: scope || body ? textOf((scope ?? body)!, true) : "",
    title,
    location: scope ? "article:text" : "body:text",
  };
}
function allowed(raw: string, domains: string[]): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      domains.includes(url.hostname.toLowerCase())
    );
  } catch {
    return false;
  }
}
function valid(
  input: WineDocumentRequest,
  c: WineDocumentContext,
  now: Date,
): boolean {
  return (
    c.workspaceId === input.workspaceId &&
    c.runId === input.runId &&
    c.source.id === input.sourceId &&
    c.source.kind === "web" &&
    c.inputRevision === input.inputRevision &&
    c.currentInputRevision === input.inputRevision &&
    c.currentRunId === input.runId &&
    c.flowVersion === "wine-enrichment-v1" &&
    ["queued", "running"].includes(c.executionState) &&
    Date.parse(c.acceptedAt) <= now.getTime() &&
    Date.parse(c.deadlineAt) <= Date.parse(c.acceptedAt) + 15 * 60 * 1000 &&
    Date.parse(c.deadlineAt) > now.getTime() &&
    !!c.source.url &&
    allowed(c.source.url, c.allowedDomains)
  );
}
export function createWineDocumentService(deps: {
  store: WineDocumentStore;
  publicFetch?: PublicFetch;
  now?: () => Date;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const wait =
    deps.wait ??
    ((ms: number, signal: AbortSignal) => pause(ms, undefined, { signal }));
  const fetch = deps.publicFetch ?? createPublicFetch(),
    now = deps.now ?? (() => new Date());
  return async (raw: WineDocumentRequest): Promise<WineDocumentOutcome> => {
    const input = wineDocumentRequestSchema.parse(raw),
      claim = await deps.store.claim(input, now().toISOString());
    if (claim.state === "stale" || claim.state === "unknown")
      return { status: claim.state };
    if (claim.state === "completed") {
      const result = wineDocumentResultSchema.parse(claim.result);
      if (
        Object.entries(input).some(
          ([key, value]) => result[key as keyof WineDocumentRequest] !== value,
        )
      )
        return { status: "stale" };
      return { status: "completed", result };
    }
    if (!valid(input, claim.context, now())) return { status: "stale" };
    const context = claim.context,
      url = context.source.url!,
      origin = new URL(url).origin;
    let result: WineDocumentResult = {
      ...input,
      schemaVersion: 1,
      state: "unavailable",
      url,
      capturedAt: now().toISOString(),
      title: "",
      text: "",
      documentDigest: digest(""),
      truncated: false,
      spans: [],
      warnings: [],
      extractEligible: false,
    };
    const signal = AbortSignal.timeout(
      Math.max(
        1,
        Math.min(30_000, Date.parse(context.deadlineAt) - now().getTime()),
      ),
    );
    try {
      const robots = await fetch({
        url: new URL("/robots.txt", origin).href,
        kind: "robots",
        lockedOrigin: origin,
        signal,
        approveUrl: (target) =>
          new URL(target).origin === origin &&
          allowed(target, context.allowedDomains),
      });
      const policy = parseRobots(robots);
      if (!isRobotsAllowed(policy, url)) {
        result.state = "denied";
        result.warnings = ["robots_denied"];
      } else if (input.kind === "robots") {
        result.state = "ready";
      } else {
        if (Date.parse(context.deadlineAt) <= now().getTime())
          return { status: "stale" };
        const delayMs = Math.max(1, policy.crawlDelaySeconds) * 1000;
        if (
          delayMs >=
          Math.min(30_000, Date.parse(context.deadlineAt) - now().getTime())
        )
          throw new Error("crawl_delay_exceeds_deadline");
        await wait(delayMs, signal);
        if (Date.parse(context.deadlineAt) <= now().getTime())
          return { status: "stale" };
        const document = await fetch({
          url,
          kind: "product",
          lockedOrigin: origin,
          signal,
          approveUrl: (target) =>
            allowed(target, context.allowedDomains) &&
            isRobotsAllowed(policy, target),
          crawlDelaySeconds: policy.crawlDelaySeconds,
        });
        if (
          !allowed(document.url, context.allowedDomains) ||
          !isRobotsAllowed(policy, document.url)
        ) {
          result.state = "denied";
          result.warnings = ["document_policy_denied"];
        } else if (
          document.status === 401 ||
          document.status === 403 ||
          document.status === 429
        ) {
          result.state = "denied";
          result.warnings = ["document_access_denied"];
        } else if (document.status >= 200 && document.status < 300) {
          const parsed = extractDocument({
            url: document.url,
            capturedAt: document.capturedAt,
            html: document.text,
            contentType: document.contentType,
          });
          const generic = article(document.text);
          const fullText = parsed.product
            ? [parsed.product.title, parsed.product.description]
                .filter(Boolean)
                .join("\n")
            : generic.text;
          const truncated = fullText.length > WINE_DOCUMENT_TEXT_LIMIT;
          const retained = truncated
            ? fullText.slice(
                0,
                WINE_DOCUMENT_TEXT_LIMIT -
                  WINE_DOCUMENT_TRUNCATION_MARKER.length,
              )
            : fullText;
          result = {
            ...result,
            url: document.url,
            capturedAt: document.capturedAt,
            state: fullText ? "ready" : "unavailable",
            title: (parsed.product?.title ?? generic.title).slice(0, 500),
            text: retained + (truncated ? WINE_DOCUMENT_TRUNCATION_MARKER : ""),
            documentDigest: digest(fullText),
            truncated,
            spans: retained
              ? [
                  {
                    start: 0,
                    end: retained.length,
                    location: parsed.product
                      ? "product:title-description"
                      : generic.location,
                  },
                ]
              : [],
            warnings: parsed.warnings,
            extractEligible: !!fullText,
          };
        }
      }
    } catch {
      result.warnings = ["document_unavailable"];
    }
    if (Date.parse(context.deadlineAt) <= now().getTime())
      return { status: "stale" };
    result = wineDocumentResultSchema.parse(result);
    if (!(await deps.store.finish(input, result, now().toISOString())))
      return { status: "stale" };
    return { status: "completed", result };
  };
}
