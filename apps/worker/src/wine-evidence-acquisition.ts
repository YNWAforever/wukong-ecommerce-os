import { createWineEvidenceStore, type Database } from "@wukong/db";
import { createWineDocumentClient } from "./wine-document-client.js";
import {
  productIdentitySchema,
  resolveWineSourceAuthority,
  type ProductIdentity,
  type EvidenceSource,
  type WineSourceAuthority,
} from "@wukong/core";
import {
  TavilyProviderError,
  TavilyProvider,
  type TavilyResponse,
} from "@wukong/ai";
import {
  wineSearchOutputSchema,
  wineDocumentResultSchema,
  WINE_DOCUMENT_TRUNCATION_MARKER,
  type WineDocumentRequest,
  type WineDocumentResult,
  type WineSearchOutput,
} from "@wukong/jobs";
import type {
  WineEvidenceStore,
  WineAcquisitionCoordinates,
  WinePhysicalCall,
} from "@wukong/db";
export type EvidenceRequest = WineAcquisitionCoordinates & {
  identity: ProductIdentity;
  now: string;
  forceRefresh: boolean;
};
export type EvidenceAcquisition = {
  sources: EvidenceSource[];
  status: "complete" | "partial" | "unavailable";
  warnings: string[];
};
export type WineAcquisitionStage =
  | { stage: "basic"; slots: ("basic_1" | "basic_2")[] }
  | { stage: "deep" }
  | { stage: "extract"; sourceIds: string[] };
export type WineAcquisitionPorts = {
  /** Server-owned complete pool integration bypasses legacy invocation snapshots. */
  cacheMode?: "invocation" | "complete_pool";
  store: WineEvidenceStore;
  provider: Pick<TavilyProvider, "search" | "extract">;
  document: (input: WineDocumentRequest) => Promise<WineDocumentResult>;
  now?: () => Date;
};
function normalize(value: unknown): unknown {
  if (typeof value === "string")
    return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(v)]),
    );
  return value;
}
export function wineEvidenceCacheKey(input: EvidenceRequest): string {
  return JSON.stringify({
    workspaceId: input.workspaceId,
    identity: normalize(productIdentitySchema.parse(input.identity)),
    policyDigest: input.policyDigest,
    rulesVersion: input.rulesVersion,
    allowedDomains: [...input.allowedDomains].sort(),
  });
}
/** Semantic complete-pool key; provenance is checked separately against committed origin records. */
export function wineCompleteEvidenceCacheKey(input: EvidenceRequest): string {
  const identity = productIdentitySchema.parse(input.identity);
  const observations = (
    values: ProductIdentity["observations"] | ProductIdentity["category"],
  ) =>
    Object.fromEntries(
      Object.entries(values).map(([key, value]) => [
        key,
        value && { value: value.value, state: value.state },
      ]),
    );
  return JSON.stringify({
    namespace: "wine-complete-evidence@1",
    workspaceId: input.workspaceId,
    identity: normalize({
      ...identity,
      observations: observations(identity.observations),
      category: observations(identity.category),
    }),
    policyDigest: input.policyDigest,
    rulesVersion: input.rulesVersion,
    allowedDomains: [...input.allowedDomains].sort(),
  });
}
export function wineIdentityQueries(raw: ProductIdentity): [string, string] {
  const identity = productIdentitySchema.parse(raw);
  function term(value: string | null) {
    if (
      !value ||
      value.length > 200 ||
      !/^[\p{L}\p{N}\p{M} '\-.,()]+$/u.test(value)
    )
      throw new Error("public_identity_required");
    return value.normalize("NFKC").trim().replace(/\s+/g, " ");
  }
  const base = [
    term(identity.producer),
    term(identity.productName),
    identity.vintage.state === "known" ? String(identity.vintage.year) : "",
    identity.volumeMl ? `${identity.volumeMl}ml` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return [base, `${base} ${identity.kind} producer technical sheet`];
}
async function hash(value: string) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
async function evidenceId(value: string) {
  const h = await hash(value);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
function publicUrl(value: string, domains: string[]): string | null {
  try {
    const u = new URL(value);
    if (
      u.protocol !== "https:" ||
      u.username ||
      u.password ||
      u.port ||
      !domains.includes(u.hostname) ||
      !u.hostname.includes(".") ||
      /^[\d.]+$/.test(u.hostname) ||
      u.hostname.includes(":") ||
      u.hostname.endsWith(".localhost") ||
      u.hostname.endsWith(".local")
    )
      return null;
    u.hash = "";
    return u.href;
  } catch {
    return null;
  }
}
function retained(text: string) {
  const truncated = text.length > 16000;
  return {
    content: truncated
      ? text.slice(0, 16000 - WINE_DOCUMENT_TRUNCATION_MARKER.length) +
        WINE_DOCUMENT_TRUNCATION_MARKER
      : text,
    truncated,
  };
}
function authority(
  source: EvidenceSource,
  identity: ProductIdentity,
  entries: WineSourceAuthority[],
  now: string,
): EvidenceSource {
  const record = identity.producer
    ? resolveWineSourceAuthority(
        source,
        { kind: "producer", name: identity.producer },
        entries,
        now,
      )
    : null;
  return { ...source, trust: record ? "verified_official" : "unverified" };
}
export async function acquireWineEvidence(
  input: EvidenceRequest,
  stage: WineAcquisitionStage,
  ports: WineAcquisitionPorts,
): Promise<EvidenceAcquisition> {
  const warnings: string[] = [],
    sources: EvidenceSource[] = [];
  const context = await ports.store.context(input);
  if (!context)
    return { sources, status: "unavailable", warnings: ["stale_acquisition"] };
  const acceptedAt = context.acceptedAt,
    deadlineAt = context.deadlineAt;
  const now = () => (ports.now?.() ?? new Date()).toISOString();
  let deadlineExpired = false;
  function expired() {
    if (!deadlineExpired && Date.parse(now()) >= Date.parse(deadlineAt)) {
      deadlineExpired = true;
      warnings.push("deadline_expired");
    }
    return deadlineExpired;
  }
  const key = {
    identityKey: await hash(wineEvidenceCacheKey(input)),
    policyVersion: input.policyDigest,
    rulesVersion: input.rulesVersion,
  };
  const registry = await ports.store.authorities(input);
  const eligible = (source: EvidenceSource) =>
    !!source.url &&
    !!publicUrl(source.url, input.allowedDomains) &&
    Date.parse(source.capturedAt) <= Date.parse(context.now) &&
    Date.parse(source.capturedAt) > Date.parse(context.now) - 7 * 86400000;
  if (
    ports.cacheMode !== "complete_pool" &&
    stage.stage === "basic" &&
    !input.forceRefresh
  ) {
    const cached = await ports.store.cache(input, key);
    if (
      cached &&
      cached.runId !== input.runId &&
      cached.payload.sources.length &&
      cached.payload.sources.every(eligible)
    )
      return {
        sources: cached.payload.sources.map((s) =>
          authority(s, input.identity, registry, context.now),
        ),
        status: "complete",
        warnings: [],
      };
  }
  const old = [...(await ports.store.readEvidence(input))];
  async function persist(source: EvidenceSource) {
    const found = old.find((s) => s.id === source.id);
    if (found) return found;
    await ports.store.saveEvidence(input, [source]);
    old.push(source);
    return source;
  }
  async function physical(
    call: WinePhysicalCall,
    perform: () => Promise<TavilyResponse>,
    urls?: string[],
  ): Promise<{ output: WineSearchOutput; capturedAt: string } | null> {
    if (expired()) return null;
    const admission = await ports.store.admit(input, call);
    if (admission.state === "completed")
      return {
        output: admission.record.output!,
        capturedAt: admission.record.updatedAt,
      };
    if (admission.state !== "claimed") {
      warnings.push(
        admission.state === "unknown"
          ? "outcome_unknown"
          : "acquisition_blocked",
      );
      return null;
    }
    try {
      if (Date.parse(now()) >= Date.parse(deadlineAt))
        throw new TavilyProviderError("outcome_unknown");
      const response = await perform();
      if (response.credits === null)
        throw new TavilyProviderError("outcome_unknown");
      if (response.credits > call.maximumCredits)
        throw new TavilyProviderError("cost_discrepancy", {
          credits: response.credits,
        });
      if (urls && response.results.some((r) => !urls.includes(r.url)))
        throw new TavilyProviderError("invalid_output", {
          credits: response.credits,
        });
      const output = wineSearchOutputSchema.parse({
        schemaVersion: 1,
        requestId:
          response.requestId && /^[\w.:-]{1,200}$/.test(response.requestId)
            ? response.requestId
            : null,
        results: response.results.map((r) => ({
          url: r.url,
          title: r.title.slice(0, 500),
          ...retained(urls ? (r.rawContent ?? r.content) : r.content),
        })),
      });
      if (
        !(await ports.store.finish(input, {
          ...call,
          status: "succeeded",
          credits: response.credits,
          output,
        }))
      ) {
        warnings.push("outcome_unknown");
        return null;
      }
      const saved = await ports.store.admit(input, call);
      if (saved.state !== "completed") {
        warnings.push("outcome_unknown");
        return null;
      }
      return {
        output: saved.record.output!,
        capturedAt: saved.record.updatedAt,
      };
    } catch (error) {
      const known =
        error instanceof TavilyProviderError
          ? error
          : new TavilyProviderError("outcome_unknown");
      await ports.store.finish(input, {
        ...call,
        status: "unknown",
        credits: null,
        diagnostic: {
          schemaVersion: 1,
          code: known.code,
          requestId:
            known.requestId && /^[\w.:-]{1,200}$/.test(known.requestId)
              ? known.requestId
              : null,
          measuredCredits: known.credits,
          reservedCredits: call.maximumCredits === 2 ? 2 : 1,
          httpStatus: known.status,
        },
      });
      warnings.push(known.code);
      return null;
    }
  }
  async function document(source: EvidenceSource) {
    if (expired()) return null;
    try {
      const result = wineDocumentResultSchema.parse(
        await ports.document({
          workspaceId: input.workspaceId,
          runId: input.runId,
          sourceId: source.id,
          inputRevision: input.inputRevision,
          kind: "product",
        }),
      );
      if (expired()) return null;
      if (
        !publicUrl(result.url, input.allowedDomains) ||
        result.sourceId !== source.id ||
        result.workspaceId !== input.workspaceId ||
        result.runId !== input.runId ||
        result.inputRevision !== input.inputRevision ||
        result.kind !== "product" ||
        Date.parse(result.capturedAt) < Date.parse(acceptedAt) ||
        Date.parse(result.capturedAt) > Date.parse(now())
      )
        throw new Error("invalid document");
      if (result.state !== "ready") {
        warnings.push("document_" + result.state);
        return null;
      }
      return result;
    } catch {
      warnings.push("document_unavailable");
      return null;
    }
  }
  if (stage.stage === "extract") {
    const ids = [...new Set(stage.sourceIds)];
    if (
      ids.length < 1 ||
      ids.length > 5 ||
      ids.length !== stage.sourceIds.length
    )
      return {
        sources: [],
        status: "unavailable",
        warnings: ["invalid_extract_candidates"],
      };
    const approved: WineDocumentResult[] = [];
    for (const id of ids) {
      if (expired()) break;
      const source = old.find((s) => s.id === id);
      if (
        !source ||
        source.contentScope !== "snippet" ||
        !source.location.startsWith("tavily:") ||
        !source.url ||
        !publicUrl(source.url, input.allowedDomains)
      )
        return {
          sources: [],
          status: "unavailable",
          warnings: ["invalid_extract_candidates"],
        };
      const result = await document(source);
      if (result?.extractEligible) approved.push(result);
    }
    const urls = [...new Set(approved.map((r) => r.url))].sort();
    if (urls.length) {
      const call = {
        slot: "extract_1" as const,
        maximumCredits: 1,
        requestDigest: await hash(JSON.stringify({ key, urls })),
      };
      const response = await physical(
        call,
        () => ports.provider.extract({ urls }),
        urls,
      );
      if (response)
        for (const result of response.output.results) {
          if (expired()) break;
          const origin = approved.find((r) => r.url === result.url)!;
          // The independently pinned document is the provenance anchor; changed text must be verified later.
          const source: EvidenceSource = {
            schemaVersion: 1,
            id: await evidenceId(
              input.runId + call.requestDigest + result.url + "extract",
            ),
            kind: "web",
            assetId: null,
            url: result.url,
            domain: new URL(result.url).hostname,
            title: origin.title,
            capturedAt: response.capturedAt,
            excerpt: result.content,
            location: `tavily:extract_1;source:${origin.sourceId}`,
            documentDigest: "sha256:" + (await hash(result.content)),
            contentScope: "document",
            truncated: result.truncated,
            identity: null,
            trust: "unverified",
            independenceKey:
              "sha256:" + (await hash(String(normalize(result.content)))),
          };
          if (source.excerpt.trim()) sources.push(await persist(source));
        }
    }
  } else {
    const queries = wineIdentityQueries(input.identity);
    const slots =
      stage.stage === "deep" ? ["advanced_1" as const] : stage.slots;
    if (
      !slots.length ||
      slots.length > 2 ||
      new Set(slots).size !== slots.length ||
      slots.some(
        (s) =>
          !(
            stage.stage === "deep" ? ["advanced_1"] : ["basic_1", "basic_2"]
          ).includes(s),
      )
    )
      throw new Error("invalid acquisition stage");
    const seen = new Set<string>();
    for (const slot of slots) {
      if (expired()) break;
      const query = queries[slot === "basic_2" ? 1 : 0],
        depth = slot === "advanced_1" ? "advanced" : "basic";
      const call = {
        slot,
        maximumCredits: depth === "advanced" ? 2 : 1,
        requestDigest: await hash(JSON.stringify({ key, query, depth })),
      };
      const response = await physical(call, () =>
        ports.provider.search({
          query,
          depth,
          allowedDomains: input.allowedDomains,
        }),
      );
      if (!response) break;
      for (const result of response.output.results) {
        if (expired()) break;
        const url = publicUrl(result.url, input.allowedDomains);
        if (!url || seen.has(url)) continue;
        seen.add(url);
        const snippet: EvidenceSource = {
          schemaVersion: 1,
          id: await evidenceId(
            input.runId + call.requestDigest + url + "snippet",
          ),
          kind: "web",
          assetId: null,
          url,
          title: result.title,
          domain: new URL(url).hostname,
          capturedAt: response.capturedAt,
          excerpt: result.content,
          location: `tavily:${slot}`,
          documentDigest: "sha256:" + (await hash(result.content)),
          contentScope: "snippet",
          truncated: result.truncated,
          identity: null,
          trust: "unverified",
          independenceKey:
            "sha256:" + (await hash(String(normalize(result.content)))),
        };
        const saved = await persist(snippet),
          acquired = await document(saved);
        if (acquired?.text.trim()) {
          const doc: EvidenceSource = {
            ...saved,
            id: await evidenceId(saved.id + "document"),
            url: acquired.url,
            domain: new URL(acquired.url).hostname,
            title: acquired.title,
            capturedAt: acquired.capturedAt,
            excerpt: acquired.text,
            location: acquired.spans
              .map((s) => `${s.location}:${s.start}-${s.end}`)
              .join(";"),
            documentDigest: acquired.documentDigest,
            contentScope: "document",
            truncated: acquired.truncated,
            independenceKey:
              "sha256:" + (await hash(String(normalize(acquired.text)))),
          };
          sources.push(await persist(doc));
        } else if (saved.excerpt.trim()) sources.push(saved);
      }
    }
  }
  if (
    ports.cacheMode !== "complete_pool" &&
    sources.length &&
    warnings.length === 0
  ) {
    const ids = sources.map((s) => s.id).sort(),
      snapshotId = await evidenceId(
        input.runId + key.identityKey + JSON.stringify(ids),
      ),
      existing = await ports.store.cache(input, key);
    if (
      !existing ||
      existing.snapshotId === snapshotId ||
      !existing.payload.sources.some((s) => ids.includes(s.id))
    )
      await ports.store.saveCache(input, key, snapshotId, ids);
  }
  return {
    sources: sources.map((s) =>
      authority(s, input.identity, registry, context.now),
    ),
    status: sources.length
      ? warnings.length
        ? "partial"
        : "complete"
      : "unavailable",
    warnings: [...new Set(warnings)],
  };
}

/** Task 8 constructs this inside its invocation using server-owned bindings, never a searched URL. */
export function createWineEvidenceAcquisition(config: {
  database: Pick<Database, "forWorkspace">;
  cacheMode?: "invocation" | "complete_pool";
  tavilyApiKey: string;
  websiteFetchBaseUrl: string;
  queueSecret: string;
  fetch?: typeof fetch;
  now?: () => Date;
}) {
  const ports: WineAcquisitionPorts = {
    cacheMode: config.cacheMode,
    store: createWineEvidenceStore(config.database),
    provider: new TavilyProvider({
      apiKey: config.tavilyApiKey,
      fetch: config.fetch,
    }),
    document: createWineDocumentClient({
      baseUrl: config.websiteFetchBaseUrl,
      secret: config.queueSecret,
      fetch: config.fetch,
      now: config.now,
    }),
    now: config.now,
  };
  return (input: EvidenceRequest, stage: WineAcquisitionStage) =>
    acquireWineEvidence(input, stage, ports);
}
