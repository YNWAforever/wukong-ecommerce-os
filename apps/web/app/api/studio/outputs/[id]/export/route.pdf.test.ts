import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { PDFDocument } from "pdf-lib";
import { describe, expect, it } from "vitest";

import type { StudioOutput, StudioOutputVersion } from "@wukong/db";

import { canonicalJson } from "../../../../../../lib/studio/output-service";
import type { StudioRouteDeps } from "../../../../../../lib/studio/route-deps";
import {
  createFakeStudio,
  fakeGetDatabase,
  fakeSessionContext,
  type FakeStudioOptions,
} from "../../../../../../lib/studio/test-fakes";
import { createStudioOutputExportHandler } from "./route";

/**
 * PDF export tests for `GET /api/studio/outputs/[id]/export?format=pdf` (B2).
 *
 * Each response is parsed back with `pdf-lib`, and the decoded page content
 * streams are checked for the reviewed packet fields. The digest, status and
 * foreign-id rules are asserted here too, so adding a format cannot bypass
 * them.
 */

const ON_ENV = {
  CONVERSATION_STUDIO_ENABLED: "true",
} as unknown as NodeJS.ProcessEnv;
const WORKSPACE = "ws_test";
const OUTPUT_ID = "55555555-5555-4555-8555-555555555555";
const CREATED_AT = new Date("2026-11-08T10:00:00.000Z");

const PROPOSAL_PAYLOAD = {
  listingId: "listing-1",
  activeVersionId: "version-1",
  activeVersionSequence: 7,
  fields: [
    {
      field: "title.en",
      current: "Synthetic old title",
      proposed: "Synthetic proposed title",
      evidenceRefs: ["listing:listing-1:v7"],
    },
    {
      field: "description.zh-Hant",
      current: null,
      proposed: "合成建議描述",
      evidenceRefs: ["quality:v1"],
    },
  ],
  limitations: ["Synthetic proposal limitation"],
  asOf: "2026-11-08T10:00:00.000Z",
};

const REPORT_PAYLOAD = {
  schemaVersion: "wukong-merchant-audit/v2",
  asOf: "2026-11-08T10:00:00.000Z",
  period: null,
  attemptsInPeriod: null,
  listings: [{ status: "approved", count: 1 }],
};

function digestOf(payload: unknown): string {
  return createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

function outputRow(overrides: Partial<StudioOutput> = {}): StudioOutput {
  return {
    id: OUTPUT_ID,
    workspaceId: WORKSPACE,
    threadId: null,
    runId: null,
    kind: "copy_proposal",
    title: "Synthetic copy proposal",
    status: "saved",
    currentVersion: 1,
    createdBy: "actor_ops",
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function versionRow(payload: unknown): StudioOutputVersion {
  return {
    id: "77777777-7777-4777-8777-777777777777",
    workspaceId: WORKSPACE,
    outputId: OUTPUT_ID,
    revision: 1,
    payload: payload as Record<string, unknown>,
    contentDigest: digestOf(payload),
    asOf: CREATED_AT,
    scope: { workspaceScoped: true },
    createdBy: "actor_ops",
    createdAt: CREATED_AT,
  };
}

function fixture(
  input: {
    payload?: unknown;
    options?: FakeStudioOptions;
    env?: NodeJS.ProcessEnv;
  } = {},
) {
  const payload = input.payload ?? PROPOSAL_PAYLOAD;
  const fake = createFakeStudio({
    settings: { workspaceId: WORKSPACE, enabled: true },
    outputs: [outputRow()],
    outputVersions: [versionRow(payload)],
    ...(input.options ?? {}),
  });
  const deps: StudioRouteDeps = {
    sessionContext: fakeSessionContext("reviewer", { workspaceId: WORKSPACE })
      .port,
    getDatabase: fakeGetDatabase(fake.repos, fake.state.workspaceCalls),
    env: input.env ?? ON_ENV,
  };
  return {
    fake,
    handler: createStudioOutputExportHandler(deps),
    digest: digestOf(payload),
  };
}

function request(
  digest: string | undefined,
  options: { format?: string; id?: string } = {},
): Request {
  const id = options.id ?? OUTPUT_ID;
  const url = new URL(`http://localhost/api/studio/outputs/${id}/export`);
  if (digest !== undefined) url.searchParams.set("digest", digest);
  if (options.format !== undefined)
    url.searchParams.set("format", options.format);
  return new Request(url);
}

const context = (id = OUTPUT_ID) => ({ params: Promise.resolve({ id }) });

/**
 * Validate the PDF with pdf-lib, then decode the page content streams with the
 * library's own stream decoder (the saved document compresses content streams,
 * and pdf-lib has no public text-extraction API; this avoids adding one).
 */
const requirePdfLib = createRequire(import.meta.url);
type RawStreamDecoder = {
  decodePDFRawStream: (input: { dict: unknown; contents: Uint8Array }) => {
    decode: () => Uint8Array;
  };
};
const { decodePDFRawStream } = requirePdfLib(
  "pdf-lib/cjs/core/streams/decode.js",
) as RawStreamDecoder;

/** pdf-lib writes show-text operands as hex strings (`<...> Tj`). */
function decodeShowTextOperands(content: string): string {
  return content.replace(/<([0-9A-Fa-f]+)>\s*Tj/g, (_match, hex: string) =>
    Buffer.from(hex, "hex").toString("latin1"),
  );
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const document = await PDFDocument.load(bytes);
  expect(document.getPageCount()).toBeGreaterThanOrEqual(1);
  const parts: string[] = [];
  for (const page of document.getPages()) {
    const contents = page.node.Contents() as
      { asArray?: () => unknown[] } | undefined;
    if (!contents) continue;
    const refs = Array.isArray(contents)
      ? contents
      : typeof contents.asArray === "function"
        ? contents.asArray()
        : [contents];
    for (const ref of refs) {
      const stream = document.context.lookup(ref as never) as
        { dict: unknown; contents: Uint8Array } | undefined;
      if (!stream || !stream.contents) continue;
      const decoded = decodePDFRawStream({
        dict: stream.dict,
        contents: stream.contents,
      }).decode();
      parts.push(
        decodeShowTextOperands(Buffer.from(decoded).toString("latin1")),
      );
    }
  }
  return parts.join("\n");
}

describe("GET /api/studio/outputs/[id]/export?format=pdf", () => {
  it("renders a readable copy-proposal document that pdf-lib can parse back", async () => {
    const { handler, digest } = fixture();
    const response = await handler(
      request(digest, { format: "pdf" }),
      context(),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toContain(
      `studio-output-${OUTPUT_ID}-r1.pdf`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");

    const bytes = new Uint8Array(await response.arrayBuffer());
    const document = await PDFDocument.load(bytes);
    expect(document.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(document.getTitle()).toContain("Studio output");
    expect(document.getSubject()).toContain("copy_proposal");
    expect(document.getKeywords()).toContain(OUTPUT_ID);

    const text = await pdfText(bytes);
    expect(text).toContain("Synthetic copy proposal");
    expect(text).toContain("Kind: copy_proposal");
    expect(text).toContain("Status: saved");
    expect(text).toContain("Revision: 1");
    expect(text).toContain("listing-1");
    expect(text).toContain("title.en");
    expect(text).toContain("Synthetic old title");
    expect(text).toContain("Synthetic proposed title");
    expect(text).toContain("listing:listing-1:v7");
    expect(text).toContain("Synthetic proposal limitation");
    expect(text).toContain(digest);
    // The standard font cannot encode CJK; the escape keeps it honest instead
    // of throwing or silently dropping the value.
    expect(text).toContain("[U+5408]");
  });

  it("renders non-proposal kinds as readable payload sections", async () => {
    const { handler, digest } = fixture({
      payload: REPORT_PAYLOAD,
      options: {
        outputs: [
          outputRow({ kind: "merchant_audit", title: "Merchant audit" }),
        ],
      },
    });
    const response = await handler(
      request(digest, { format: "pdf" }),
      context(),
    );
    expect(response.status).toBe(200);
    const bytes = new Uint8Array(await response.arrayBuffer());
    const text = await pdfText(bytes);
    expect(text).toContain("Merchant audit");
    expect(text).toContain("Kind: merchant_audit");
    expect(text).toContain("listings[0].status: approved");
    expect(text).toContain("schemaVersion");
  });

  it("keeps format=json as the unchanged canonical contract", async () => {
    const { handler, digest } = fixture();
    const response = await handler(
      request(digest, { format: "json" }),
      context(),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const text = await response.text();
    const parsed = JSON.parse(text) as Record<string, unknown>;
    expect(canonicalJson(parsed)).toBe(text);
    expect(parsed.payloadSha256).toBe(digest);
  });

  it("rejects an unsupported format with a 400", async () => {
    const { handler, digest } = fixture();
    for (const format of ["csv", "PDF", ""]) {
      const response = await handler(request(digest, { format }), context());
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });
    }
  });

  it("applies the saved/signed-off rule before rendering", async () => {
    const { handler, digest } = fixture({
      options: { outputs: [outputRow({ status: "draft" })] },
    });
    const response = await handler(
      request(digest, { format: "pdf" }),
      context(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "output_not_saved" });
  });

  it("applies the digest equality rule before rendering", async () => {
    const { handler } = fixture();
    const response = await handler(
      request("b".repeat(64), { format: "pdf" }),
      context(),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "output_changed" });
  });

  it("applies the foreign/unknown and disabled-Studio 404 rules", async () => {
    const { handler, digest } = fixture();
    const unknownId = "88888888-8888-4888-8888-888888888888";
    expect(
      (
        await handler(
          request(digest, { format: "pdf", id: unknownId }),
          context(unknownId),
        )
      ).status,
    ).toBe(404);

    const disabled = fixture({ env: {} as NodeJS.ProcessEnv });
    expect(
      (
        await disabled.handler(
          request(disabled.digest, { format: "pdf" }),
          context(),
        )
      ).status,
    ).toBe(404);
  });
});
