import { z } from "zod";

export const TAVILY_REQUEST_TIMEOUT_MS = 30_000;
export const TAVILY_RESPONSE_LIMIT_BYTES = 8 * 1024 * 1024;
const SEARCH_ENDPOINT = "https://api.tavily.com/search";
const EXTRACT_ENDPOINT = "https://api.tavily.com/extract";

export type TavilyResult = {
  url: string;
  title: string;
  content: string;
  rawContent: string | null;
};
export type TavilyResponse = {
  results: TavilyResult[];
  requestId: string | null;
  credits: number | null;
};
export type TavilyProviderErrorCode =
  | "rejected"
  | "rate_limited"
  | "invalid_output"
  | "outcome_unknown"
  | "cost_discrepancy";

export class TavilyProviderError extends Error {
  readonly status: number | null;
  readonly requestId: string | null;
  readonly credits: number | null;
  readonly reservedCredits: number | null;
  constructor(
    readonly code: TavilyProviderErrorCode,
    metadata: {
      status?: number | null;
      requestId?: string | null;
      credits?: number | null;
      reservedCredits?: number | null;
    } = {},
  ) {
    super(code);
    this.name = "TavilyProviderError";
    this.status = metadata.status ?? null;
    this.requestId = metadata.requestId ?? null;
    this.credits = metadata.credits ?? null;
    this.reservedCredits = metadata.reservedCredits ?? null;
  }
}

const httpsUrl = z
  .string()
  .url()
  .refine((value) => URL.canParse(value) && value.startsWith("https://"));
const searchResult = z.object({
  url: httpsUrl,
  title: z.string(),
  content: z.string(),
  raw_content: z.string().nullable().optional(),
});
const extractResult = z.object({ url: httpsUrl, raw_content: z.string() });
const responseMetadata = {
  request_id: z.string().min(1).nullable().optional(),
  usage: z.object({ credits: z.number().int().nonnegative() }).optional(),
};
const searchResponse = z.object({
  results: z.array(searchResult).max(5),
  ...responseMetadata,
});
const extractResponse = z.object({
  results: z.array(extractResult).max(5),
  ...responseMetadata,
});
const searchInput = z.object({
  query: z.string().trim().min(1),
  depth: z.enum(["basic", "advanced"]),
  allowedDomains: z.array(z.string().trim().min(1)),
});
const extractInput = z.object({ urls: z.array(httpsUrl).min(1).max(5) });

function safeRequestId(value: string | null): string | null {
  return value && value.length <= 200 && /^[\w.:/-]+$/.test(value)
    ? value
    : null;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (
      !Number.isSafeInteger(length) ||
      length < 0 ||
      length > TAVILY_RESPONSE_LIMIT_BYTES
    )
      throw new TavilyProviderError("invalid_output");
  }
  if (!response.body) throw new TavilyProviderError("invalid_output");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const item = await reader.read();
    if (item.done) break;
    size += item.value.byteLength;
    if (size > TAVILY_RESPONSE_LIMIT_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new TavilyProviderError("invalid_output");
    }
    chunks.push(item.value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TavilyProviderError("invalid_output");
  }
}

function parseProviderResponse(
  value: unknown,
  reservedCredits: number,
  kind: "search" | "extract",
): TavilyResponse {
  const parsed =
    kind === "search"
      ? searchResponse.safeParse(value)
      : extractResponse.safeParse(value);
  if (!parsed.success) throw new TavilyProviderError("invalid_output");
  const requestId = safeRequestId(parsed.data.request_id ?? null);
  const credits = parsed.data.usage?.credits ?? null;
  if (credits !== null && credits > reservedCredits)
    throw new TavilyProviderError("cost_discrepancy", {
      requestId,
      credits,
      reservedCredits,
    });
  const results =
    kind === "search"
      ? searchResponse.parse(value).results.map((result) => ({
          url: result.url,
          title: result.title,
          content: result.content,
          rawContent: result.raw_content ?? null,
        }))
      : extractResponse.parse(value).results.map((result) => ({
          url: result.url,
          title: "",
          content: result.raw_content,
          rawContent: result.raw_content,
        }));
  return { results, requestId, credits };
}

export type TavilyProviderConfig = {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
};

export class TavilyProvider {
  private readonly fetch: typeof globalThis.fetch;
  constructor(private readonly config: TavilyProviderConfig) {
    this.fetch = config.fetch ?? globalThis.fetch;
  }

  async search(input: {
    query: string;
    depth: "basic" | "advanced";
    allowedDomains: string[];
  }): Promise<TavilyResponse> {
    const parsed = searchInput.safeParse(input);
    if (!parsed.success) throw new TavilyProviderError("rejected");
    return this.request(
      SEARCH_ENDPOINT,
      {
        query: parsed.data.query,
        search_depth: parsed.data.depth,
        topic: "general",
        include_domains: parsed.data.allowedDomains,
        auto_parameters: false,
        include_answer: false,
        include_usage: true,
        max_results: 5,
      },
      parsed.data.depth === "basic" ? 1 : 2,
      "search",
    );
  }

  async extract(input: { urls: string[] }): Promise<TavilyResponse> {
    const parsed = extractInput.safeParse(input);
    if (!parsed.success) throw new TavilyProviderError("rejected");
    return this.request(
      EXTRACT_ENDPOINT,
      { urls: parsed.data.urls, extract_depth: "basic", include_usage: true },
      1,
      "extract",
    );
  }

  private async request(
    endpoint: string,
    body: Record<string, unknown>,
    reservedCredits: number,
    kind: "search" | "extract",
  ): Promise<TavilyResponse> {
    let response: Response;
    try {
      response = await this.fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.config.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        redirect: "manual",
        signal: AbortSignal.timeout(TAVILY_REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new TavilyProviderError("outcome_unknown");
    }
    const requestId = safeRequestId(response.headers.get("x-request-id"));
    if (!response.ok || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel().catch(() => undefined);
      if (response.status === 429)
        throw new TavilyProviderError("rate_limited", {
          status: response.status,
          requestId,
        });
      if ([400, 401, 403, 404, 422].includes(response.status))
        throw new TavilyProviderError("rejected", {
          status: response.status,
          requestId,
        });
      throw new TavilyProviderError("outcome_unknown", {
        status: response.status,
        requestId,
      });
    }
    let value: unknown;
    try {
      value = await readBoundedJson(response);
    } catch (error) {
      if (error instanceof TavilyProviderError) throw error;
      throw new TavilyProviderError("outcome_unknown", { requestId });
    }
    return parseProviderResponse(value, reservedCredits, kind);
  }
}
