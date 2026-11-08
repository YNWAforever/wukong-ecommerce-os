import { z } from "zod";

import {
  bilingualTextSchema,
  type BilingualText,
  studioRoleSchema,
  type StudioRole,
} from "./skill-schemas.js";

/**
 * Strict tool registry for the deterministic Studio loop and the hosted MCP
 * server (spec §3.5). Server code executes tools; a model may only request
 * one by id with validated JSON arguments.
 *
 * v1 tools never expose raw SQL, arbitrary URL fetch, credentials, signed
 * URLs or unbounded pagination, and their input schemas are strict so a
 * tenant field (`workspaceId`, `actorId`, `role`) can never arrive as a tool
 * argument — workspace and actor come from the session only.
 */

/** Tools may only reference capability-registry ids, never free text. */
const TOOL_CAPABILITY_ID_VALUES = [
  // Added by plan Task 3 to apps/web/lib/capability-registry.ts.
  "conversation-studio",
  "conversation-studio-ai",
  "studio-output-signoff",
  "wukong-mcp-server",
  "external-mcp-connections",
  // Existing capability whose surface `listing.create_draft` wraps.
  "ai-listing-generation",
] as const;
export type StudioToolCapabilityId = (typeof TOOL_CAPABILITY_ID_VALUES)[number];
/**
 * Frozen allowlist the web capability-registry consistency test cross-checks.
 * A tool whose capability id is not registered in the web app cannot be
 * exposed honestly, so the registry refuses to compile/import.
 */
export const STUDIO_TOOL_CAPABILITY_IDS: readonly StudioToolCapabilityId[] =
  Object.freeze(TOOL_CAPABILITY_ID_VALUES);
export const studioToolCapabilityIdSchema = z.enum(TOOL_CAPABILITY_ID_VALUES);

/** Execution kinds: reads are free, propose persists an artifact, dispatch acts. */
export const TOOL_KINDS = ["read", "propose", "dispatch"] as const;
export type ToolKind = (typeof TOOL_KINDS)[number];
export const toolKindSchema = z.enum(TOOL_KINDS);

export const TOOL_COST_CLASSES = ["free", "model", "paid"] as const;
export type ToolCostClass = (typeof TOOL_COST_CLASSES)[number];
export const toolCostClassSchema = z.enum(TOOL_COST_CLASSES);

/**
 * Hard per-call result bound. The MCP server rejects anything above this and
 * the internal loop truncates rather than growing a model context.
 */
export const MAX_TOOL_RESULT_BYTES = 64 * 1024;

/** The ten v1 tool ids, exactly as spec §3.5 lists them. */
const TOOL_ID_VALUES = [
  "catalog.search",
  "catalog.get",
  "quality.get_gaps",
  "imports.list",
  "exports.get",
  "jobs.list",
  "assets.list",
  "listing.get_run_status",
  "listing.create_draft",
  "listing.propose_copy",
] as const;
export type ToolId = (typeof TOOL_ID_VALUES)[number];
export const TOOL_IDS: readonly ToolId[] = Object.freeze(TOOL_ID_VALUES);
export const toolIdSchema = z.enum(TOOL_ID_VALUES);

function isZodSchema(value: unknown): value is z.ZodType {
  return (
    typeof value === "object" &&
    value !== null &&
    "safeParse" in value &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  );
}

const zodSchemaFieldSchema = z.custom<z.ZodType>(isZodSchema, {
  error: "Expected a zod schema",
});

export const toolDefinitionSchema = z.strictObject({
  id: toolIdSchema,
  label: bilingualTextSchema,
  kind: toolKindSchema,
  minRole: studioRoleSchema,
  costClass: toolCostClassSchema,
  capabilityId: studioToolCapabilityIdSchema,
  maxResultBytes: z.number().int().min(1).max(MAX_TOOL_RESULT_BYTES),
  input: zodSchemaFieldSchema,
  output: zodSchemaFieldSchema,
});

export type ToolDefinition = Readonly<{
  id: ToolId;
  label: BilingualText;
  kind: ToolKind;
  minRole: StudioRole;
  costClass: ToolCostClass;
  capabilityId: StudioToolCapabilityId;
  maxResultBytes: number;
  input: z.ZodType;
  output: z.ZodType;
}>;

const listingIdSchema = z.string().trim().min(1).max(200);
const assetIdSchema = z.string().trim().min(1).max(200);
const runIdSchema = z.string().trim().min(1).max(200);
const timestampSchema = z.iso.datetime({ offset: true });
const pageLimitSchema = z.number().int().min(1).max(50).optional();

const TOOL_ENTRIES: readonly ToolDefinition[] = [
  {
    id: "catalog.search",
    label: { "zh-Hant": "搜尋商品目錄", en: "Search catalog" },
    kind: "read",
    minRole: "operator",
    costClass: "free",
    capabilityId: "conversation-studio",
    maxResultBytes: MAX_TOOL_RESULT_BYTES,
    input: z.strictObject({
      query: z.string().trim().min(1).max(200).optional(),
      limit: pageLimitSchema,
    }),
    output: z.strictObject({
      items: z
        .array(
          z.strictObject({
            listingId: listingIdSchema,
            title: z.string().max(300),
            status: z.string().trim().min(1).max(40),
          }),
        )
        .max(50),
      truncated: z.boolean(),
    }),
  },
  {
    id: "catalog.get",
    label: { "zh-Hant": "讀取商品詳情", en: "Get listing detail" },
    kind: "read",
    minRole: "operator",
    costClass: "free",
    capabilityId: "conversation-studio",
    maxResultBytes: MAX_TOOL_RESULT_BYTES,
    input: z.strictObject({ listingId: listingIdSchema }),
    output: z.strictObject({
      listingId: listingIdSchema,
      status: z.string().trim().min(1).max(40),
      title: z.string().max(300),
      activeVersion: z
        .strictObject({
          versionId: z.string().trim().min(1).max(200),
          sequence: z.number().int().min(1),
        })
        .nullable(),
    }),
  },
  {
    id: "quality.get_gaps",
    label: { "zh-Hant": "讀取品質缺口", en: "Get quality gaps" },
    kind: "read",
    minRole: "operator",
    costClass: "free",
    capabilityId: "conversation-studio",
    maxResultBytes: MAX_TOOL_RESULT_BYTES,
    input: z.strictObject({
      listingIds: z.array(listingIdSchema).min(1).max(50),
    }),
    output: z.strictObject({
      gaps: z
        .array(
          z.strictObject({
            listingId: listingIdSchema,
            code: z.string().trim().min(1).max(80),
            blocking: z.boolean(),
          }),
        )
        .max(200),
    }),
  },
  {
    id: "imports.list",
    label: { "zh-Hant": "列出匯入紀錄", en: "List imports" },
    kind: "read",
    minRole: "operator",
    costClass: "free",
    capabilityId: "conversation-studio",
    maxResultBytes: 32 * 1024,
    input: z.strictObject({ limit: pageLimitSchema }),
    output: z.strictObject({
      items: z
        .array(
          z.strictObject({
            importId: z.string().trim().min(1).max(200),
            state: z.string().trim().min(1).max(40),
            receivedAt: timestampSchema,
          }),
        )
        .max(50),
      truncated: z.boolean(),
    }),
  },
  {
    id: "exports.get",
    label: { "zh-Hant": "讀取匯出紀錄", en: "Get export attempt" },
    kind: "read",
    minRole: "operator",
    costClass: "free",
    capabilityId: "conversation-studio",
    maxResultBytes: 16 * 1024,
    input: z.strictObject({
      exportAttemptId: z.string().trim().min(1).max(200),
    }),
    output: z.strictObject({
      exportAttemptId: z.string().trim().min(1).max(200),
      state: z.string().trim().min(1).max(40),
      reconciliation: z.enum(["matched", "unmatched", "unknown"]),
    }),
  },
  {
    id: "jobs.list",
    label: { "zh-Hant": "列出作業紀錄", en: "List jobs" },
    kind: "read",
    minRole: "operator",
    costClass: "free",
    capabilityId: "conversation-studio",
    maxResultBytes: 32 * 1024,
    input: z.strictObject({ limit: pageLimitSchema }),
    output: z.strictObject({
      items: z
        .array(
          z.strictObject({
            jobId: z.string().trim().min(1).max(200),
            state: z.string().trim().min(1).max(40),
            createdAt: timestampSchema,
          }),
        )
        .max(50),
      truncated: z.boolean(),
    }),
  },
  {
    id: "assets.list",
    label: { "zh-Hant": "列出商品素材", en: "List listing assets" },
    kind: "read",
    minRole: "operator",
    costClass: "free",
    capabilityId: "conversation-studio",
    maxResultBytes: 32 * 1024,
    // Asset ids only: presigned URLs are minted at render time and are never
    // model/tool output (spec §3.3, §3.5).
    input: z.strictObject({ listingId: listingIdSchema }),
    output: z.strictObject({
      items: z
        .array(
          z.strictObject({
            assetId: assetIdSchema,
            role: z.enum(["source", "derived"]),
            contentType: z.string().trim().min(1).max(100),
          }),
        )
        .max(100),
    }),
  },
  {
    id: "listing.get_run_status",
    label: { "zh-Hant": "讀取上架流程狀態", en: "Get listing run status" },
    kind: "read",
    minRole: "operator",
    costClass: "free",
    capabilityId: "ai-listing-generation",
    maxResultBytes: 8 * 1024,
    input: z.strictObject({
      listingId: listingIdSchema,
      runId: runIdSchema,
    }),
    output: z.strictObject({
      listingId: listingIdSchema,
      runId: runIdSchema,
      state: z.enum([
        "queued",
        "running",
        "succeeded",
        "failed",
        "cancelled",
        "outcome_unknown",
        "unavailable",
      ]),
    }),
  },
  {
    id: "listing.create_draft",
    label: { "zh-Hant": "建立商品草稿", en: "Create listing draft" },
    kind: "dispatch",
    minRole: "operator",
    // The intake path can start AI listing generation, which is paid
    // downstream. Budget admission for that work stays with the existing
    // listing pipeline, not with the Studio turn.
    costClass: "paid",
    capabilityId: "ai-listing-generation",
    maxResultBytes: 8 * 1024,
    input: z.strictObject({
      assetIds: z.array(assetIdSchema).min(1).max(8),
      note: z.string().max(2000).optional(),
      // Explicit operator confirmation is part of the contract, not the UI
      // only: a model or tool caller cannot dispatch by accident.
      confirmed: z.literal(true),
    }),
    output: z.strictObject({
      listingId: listingIdSchema,
      runId: runIdSchema.nullable(),
      queueState: z.enum(["enqueued", "queue_unavailable"]),
    }),
  },
  {
    id: "listing.propose_copy",
    label: { "zh-Hant": "建立文案建議", en: "Propose listing copy" },
    kind: "propose",
    minRole: "operator",
    costClass: "free",
    capabilityId: "conversation-studio",
    maxResultBytes: 4 * 1024,
    // Creates a versioned Studio artifact; it never writes canonical listing
    // data (spec §3.5, plan Task 9).
    input: z.strictObject({
      listingId: listingIdSchema,
      activeVersionId: z.string().trim().min(1).max(200),
      fields: z
        .array(
          z.strictObject({
            field: z.string().trim().min(1).max(80),
            current: z.string().max(2000).nullable(),
            proposed: z.string().trim().min(1).max(2000),
            evidenceRefs: z
              .array(z.string().trim().min(1).max(200))
              .min(1)
              .max(10),
          }),
        )
        .min(1)
        .max(40),
    }),
    output: z.strictObject({
      outputId: z.string().trim().min(1).max(200),
      revision: z.number().int().min(1),
    }),
  },
];

function freezeToolDefinition(tool: ToolDefinition): ToolDefinition {
  // Object.freeze is shallow. Freeze the entry and its bilingual label, but
  // deliberately not the zod input/output instances: those are shared schema
  // objects with internal state, so freezing them would be unsafe.
  return Object.freeze({
    ...tool,
    label: Object.freeze({ ...tool.label }),
    input: tool.input,
    output: tool.output,
  });
}

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = Object.freeze(
  TOOL_ENTRIES.map((tool) => {
    toolDefinitionSchema.parse(tool);
    return freezeToolDefinition(tool);
  }),
);

export function getTool(id: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.id === id);
}
