import type { CanonicalListing } from "@wukong/core";
import {
  type AnyPgColumn,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
};

export const listingStatus = pgEnum("listing_status", [
  "received", "processing", "needs_info", "in_review", "approved",
  "reopened", "publishing", "published", "publish_failed", "failed",
]);

export const workspaces = pgTable("workspaces", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  profile: jsonb("profile").notNull(),
  createdAt: timestamps.createdAt,
});

export const users = pgTable("users", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name"),
  createdAt: timestamps.createdAt,
  updatedAt: timestamps.updatedAt,
});

export const accounts = pgTable("accounts", {
  id: uuid("id").defaultRandom().primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamps.createdAt,
}, (table) => [
  uniqueIndex("accounts_provider_account_uq").on(table.provider, table.providerAccountId),
  index("accounts_user_id_idx").on(table.userId),
]);

export const sessions = pgTable("sessions", {
  sessionToken: text("session_token").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [index("sessions_user_id_idx").on(table.userId)]);

export const verificationTokens = pgTable("verification_tokens", {
  identifier: text("identifier").notNull(),
  token: text("token").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [primaryKey({ columns: [table.identifier, table.token] })]);

export const memberships = pgTable("memberships", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }).notNull(),
  role: text("role").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  uniqueIndex("memberships_workspace_user_uq").on(table.workspaceId, table.userId),
  index("memberships_user_id_idx").on(table.userId),
]);

const listingVersionWorkspaceId = (): AnyPgColumn =>
  listingVersions.workspaceId;
const listingVersionId = (): AnyPgColumn => listingVersions.id;

export const listingDrafts = pgTable("listing_drafts", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  status: listingStatus("status").default("received").notNull(),
  target: text("target").default("shopline").notNull(),
  note: text("note"),
  activeVersionId: uuid("active_version_id"),
  createdAt: timestamps.createdAt,
  updatedAt: timestamps.updatedAt,
}, (table) => [
  uniqueIndex("listing_drafts_workspace_id_uq").on(table.workspaceId, table.id),
  index("listing_drafts_workspace_status_idx").on(table.workspaceId, table.status),
  index("listing_drafts_workspace_active_version_idx").on(
    table.workspaceId,
    table.activeVersionId,
  ),
  foreignKey({
    name: "listing_drafts_workspace_active_version_fkey",
    columns: [table.workspaceId, table.activeVersionId],
    foreignColumns: [
      listingVersionWorkspaceId(),
      listingVersionId(),
    ],
  }).onDelete("restrict"),
]);

export const listingVersions = pgTable("listing_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  listingId: uuid("listing_id").notNull(),
  sequence: integer("sequence").notNull(),
  pipelineIdempotencyKey: text("pipeline_idempotency_key"),
  content: jsonb("content").$type<CanonicalListing>().notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  uniqueIndex("listing_versions_workspace_id_uq").on(table.workspaceId, table.id),
  uniqueIndex("listing_versions_listing_sequence_uq").on(table.listingId, table.sequence),
  uniqueIndex("listing_versions_workspace_pipeline_idempotency_uq").on(
    table.workspaceId,
    table.listingId,
    table.pipelineIdempotencyKey,
  ),
  index("listing_versions_workspace_listing_idx").on(table.workspaceId, table.listingId),
  foreignKey({
    name: "listing_versions_workspace_listing_fkey",
    columns: [table.workspaceId, table.listingId],
    foreignColumns: [listingDrafts.workspaceId, listingDrafts.id],
  }).onDelete("cascade"),
]);

export const sourceAssets = pgTable("source_assets", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  listingId: uuid("listing_id"),
  storageKey: text("storage_key").notNull(),
  kind: text("kind").notNull(),
  metadata: jsonb("metadata").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  uniqueIndex("source_assets_workspace_id_uq").on(table.workspaceId, table.id),
  uniqueIndex("source_assets_workspace_storage_key_uq").on(table.workspaceId, table.storageKey),
  index("source_assets_workspace_listing_idx").on(table.workspaceId, table.listingId),
  foreignKey({
    name: "source_assets_workspace_listing_fkey",
    columns: [table.workspaceId, table.listingId],
    foreignColumns: [listingDrafts.workspaceId, listingDrafts.id],
  }).onDelete("cascade"),
]);

export const fieldEvidence = pgTable("field_evidence", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  listingVersionId: uuid("listing_version_id").notNull(),
  sourceAssetId: uuid("source_asset_id"),
  fieldPath: text("field_path").notNull(),
  evidence: jsonb("evidence").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  index("field_evidence_workspace_version_idx").on(
    table.workspaceId,
    table.listingVersionId,
  ),
  index("field_evidence_workspace_source_asset_idx").on(
    table.workspaceId,
    table.sourceAssetId,
  ),
  foreignKey({
    name: "field_evidence_workspace_version_fkey",
    columns: [table.workspaceId, table.listingVersionId],
    foreignColumns: [listingVersions.workspaceId, listingVersions.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "field_evidence_workspace_source_asset_fkey",
    columns: [table.workspaceId, table.sourceAssetId],
    foreignColumns: [sourceAssets.workspaceId, sourceAssets.id],
  }).onDelete("restrict"),
]);

export const complianceFlags = pgTable("compliance_flags", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  listingVersionId: uuid("listing_version_id").notNull(),
  code: text("code").notNull(),
  severity: text("severity").notNull(),
  status: text("status").notNull(),
  details: jsonb("details").notNull(),
  createdAt: timestamps.createdAt,
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (table) => [
  index("compliance_flags_workspace_version_idx").on(
    table.workspaceId,
    table.listingVersionId,
  ),
  foreignKey({
    name: "compliance_flags_workspace_version_fkey",
    columns: [table.workspaceId, table.listingVersionId],
    foreignColumns: [listingVersions.workspaceId, listingVersions.id],
  }).onDelete("cascade"),
]);

export const promptVersions = pgTable("prompt_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  key: text("key").notNull(),
  version: integer("version").notNull(),
  template: text("template").notNull(),
  model: text("model").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  uniqueIndex("prompt_versions_workspace_id_uq").on(table.workspaceId, table.id),
  uniqueIndex("prompt_versions_workspace_key_version_uq").on(
    table.workspaceId,
    table.key,
    table.version,
  ),
]);

export const aiRuns = pgTable("ai_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  listingId: uuid("listing_id").notNull(),
  promptVersionId: uuid("prompt_version_id"),
  task: text("task").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull(),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  error: text("error"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  latencyMs: integer("latency_ms").notNull(),
  estimatedCostUsd: numeric("estimated_cost_usd", {
    precision: 14,
    scale: 6,
  }).notNull(),
  createdAt: timestamps.createdAt,
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  uniqueIndex("ai_runs_workspace_task_idempotency_uq").on(
    table.workspaceId,
    table.listingId,
    table.task,
    table.idempotencyKey,
  ),
  index("ai_runs_workspace_listing_idx").on(table.workspaceId, table.listingId),
  index("ai_runs_workspace_prompt_version_idx").on(
    table.workspaceId,
    table.promptVersionId,
  ),
  foreignKey({
    name: "ai_runs_workspace_listing_fkey",
    columns: [table.workspaceId, table.listingId],
    foreignColumns: [listingDrafts.workspaceId, listingDrafts.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "ai_runs_workspace_prompt_version_fkey",
    columns: [table.workspaceId, table.promptVersionId],
    foreignColumns: [promptVersions.workspaceId, promptVersions.id],
  }),
]);

export const listingPipelineRuns = pgTable("listing_pipeline_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  listingId: uuid("listing_id").notNull(),
  activeVersionSequence: integer("active_version_sequence").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: text("status").notNull(),
  resultStatus: listingStatus("result_status"),
  versionId: uuid("version_id"),
  errorCode: text("error_code"),
  createdAt: timestamps.createdAt,
  updatedAt: timestamps.updatedAt,
}, (table) => [
  uniqueIndex("listing_pipeline_runs_workspace_id_uq").on(table.workspaceId, table.id),
  uniqueIndex("listing_pipeline_runs_workspace_idempotency_uq").on(table.workspaceId, table.idempotencyKey),
  index("listing_pipeline_runs_workspace_listing_idx").on(table.workspaceId, table.listingId),
  index("listing_pipeline_runs_workspace_version_idx").on(table.workspaceId, table.versionId),
  foreignKey({ name: "listing_pipeline_runs_workspace_listing_fkey", columns: [table.workspaceId, table.listingId], foreignColumns: [listingDrafts.workspaceId, listingDrafts.id] }).onDelete("cascade"),
  foreignKey({ name: "listing_pipeline_runs_workspace_version_fkey", columns: [table.workspaceId, table.versionId], foreignColumns: [listingVersions.workspaceId, listingVersions.id] }).onDelete("restrict"),
]);

export const listingPipelineSteps = pgTable("listing_pipeline_steps", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  pipelineRunId: uuid("pipeline_run_id").notNull(),
  step: text("step").notNull(),
  state: text("state").default("completed").notNull(),
  leaseToken: uuid("lease_token").defaultRandom().notNull(),
  output: jsonb("output"),
  updatedAt: timestamps.updatedAt,
  createdAt: timestamps.createdAt,
}, (table) => [
  uniqueIndex("listing_pipeline_steps_workspace_step_uq").on(table.workspaceId, table.pipelineRunId, table.step),
  index("listing_pipeline_steps_workspace_run_idx").on(table.workspaceId, table.pipelineRunId),
  foreignKey({ name: "listing_pipeline_steps_workspace_run_fkey", columns: [table.workspaceId, table.pipelineRunId], foreignColumns: [listingPipelineRuns.workspaceId, listingPipelineRuns.id] }).onDelete("cascade"),
]);
export const shoplineConnections = pgTable("shopline_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  shopDomain: text("shop_domain").notNull(),
  encryptedAccessToken: text("encrypted_access_token").notNull(),
  createdAt: timestamps.createdAt,
  updatedAt: timestamps.updatedAt,
}, (table) => [
  uniqueIndex("shopline_connections_workspace_id_uq").on(
    table.workspaceId,
    table.id,
  ),
  uniqueIndex("shopline_connections_workspace_domain_uq").on(
    table.workspaceId,
    table.shopDomain,
  ),
]);

export const publishJobs = pgTable("publish_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  listingId: uuid("listing_id").notNull(),
  connectionId: uuid("connection_id").notNull(),
  status: text("status").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  remoteProductId: text("remote_product_id"),
  error: text("error"),
  createdAt: timestamps.createdAt,
  updatedAt: timestamps.updatedAt,
}, (table) => [
  uniqueIndex("publish_jobs_workspace_idempotency_uq").on(
    table.workspaceId,
    table.idempotencyKey,
  ),
  index("publish_jobs_workspace_status_idx").on(table.workspaceId, table.status),
  index("publish_jobs_workspace_listing_idx").on(table.workspaceId, table.listingId),
  index("publish_jobs_workspace_connection_idx").on(
    table.workspaceId,
    table.connectionId,
  ),
  foreignKey({
    name: "publish_jobs_workspace_listing_fkey",
    columns: [table.workspaceId, table.listingId],
    foreignColumns: [listingDrafts.workspaceId, listingDrafts.id],
  }).onDelete("cascade"),
  foreignKey({
    name: "publish_jobs_workspace_connection_fkey",
    columns: [table.workspaceId, table.connectionId],
    foreignColumns: [shoplineConnections.workspaceId, shoplineConnections.id],
  }),
]);

export const reviewEvents = pgTable("review_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  listingId: uuid("listing_id").notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  metadata: jsonb("metadata").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  index("review_events_workspace_listing_idx").on(table.workspaceId, table.listingId),
  foreignKey({
    name: "review_events_workspace_listing_fkey",
    columns: [table.workspaceId, table.listingId],
    foreignColumns: [listingDrafts.workspaceId, listingDrafts.id],
  }).onDelete("cascade"),
]);

export const auditEvents = pgTable("audit_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  actorId: text("actor_id").notNull(),
  entityId: text("entity_id").notNull(),
  action: text("action").notNull(),
  metadata: jsonb("metadata").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  index("audit_events_workspace_created_idx").on(table.workspaceId, table.createdAt),
]);