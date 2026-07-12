import type { CanonicalListing } from "@wukong/core";
import {
  index,
  integer,
  jsonb,
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

export const listingDrafts = pgTable("listing_drafts", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  status: listingStatus("status").default("received").notNull(),
  target: text("target").default("shopline").notNull(),
  activeVersionId: uuid("active_version_id"),
  createdAt: timestamps.createdAt,
  updatedAt: timestamps.updatedAt,
}, (table) => [
  index("listing_drafts_workspace_status_idx").on(table.workspaceId, table.status),
]);

export const listingVersions = pgTable("listing_versions", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  listingId: uuid("listing_id").references(() => listingDrafts.id, { onDelete: "cascade" }).notNull(),
  sequence: integer("sequence").notNull(),
  content: jsonb("content").$type<CanonicalListing>().notNull(),
  createdBy: text("created_by").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  uniqueIndex("listing_versions_listing_sequence_uq").on(table.listingId, table.sequence),
  index("listing_versions_workspace_listing_idx").on(table.workspaceId, table.listingId),
  index("listing_versions_listing_id_idx").on(table.listingId),
]);

export const sourceAssets = pgTable("source_assets", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  listingId: uuid("listing_id").references(() => listingDrafts.id, { onDelete: "cascade" }).notNull(),
  storageKey: text("storage_key").notNull(),
  kind: text("kind").notNull(),
  metadata: jsonb("metadata").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  index("source_assets_workspace_listing_idx").on(table.workspaceId, table.listingId),
  index("source_assets_listing_id_idx").on(table.listingId),
]);

export const fieldEvidence = pgTable("field_evidence", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  listingVersionId: uuid("listing_version_id").references(() => listingVersions.id, { onDelete: "cascade" }).notNull(),
  sourceAssetId: uuid("source_asset_id").references(() => sourceAssets.id, { onDelete: "set null" }),
  fieldPath: text("field_path").notNull(),
  evidence: jsonb("evidence").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  index("field_evidence_workspace_version_idx").on(table.workspaceId, table.listingVersionId),
  index("field_evidence_listing_version_id_idx").on(table.listingVersionId),
  index("field_evidence_source_asset_id_idx").on(table.sourceAssetId),
]);

export const complianceFlags = pgTable("compliance_flags", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  listingVersionId: uuid("listing_version_id").references(() => listingVersions.id, { onDelete: "cascade" }).notNull(),
  code: text("code").notNull(),
  severity: text("severity").notNull(),
  status: text("status").notNull(),
  details: jsonb("details").notNull(),
  createdAt: timestamps.createdAt,
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
}, (table) => [
  index("compliance_flags_workspace_version_idx").on(table.workspaceId, table.listingVersionId),
  index("compliance_flags_listing_version_id_idx").on(table.listingVersionId),
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
  uniqueIndex("prompt_versions_workspace_key_version_uq").on(table.workspaceId, table.key, table.version),
]);

export const aiRuns = pgTable("ai_runs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  listingId: uuid("listing_id").references(() => listingDrafts.id, { onDelete: "cascade" }).notNull(),
  promptVersionId: uuid("prompt_version_id").references(() => promptVersions.id).notNull(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  status: text("status").notNull(),
  input: jsonb("input").notNull(),
  output: jsonb("output"),
  error: text("error"),
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  createdAt: timestamps.createdAt,
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("ai_runs_workspace_listing_idx").on(table.workspaceId, table.listingId),
  index("ai_runs_listing_id_idx").on(table.listingId),
  index("ai_runs_prompt_version_id_idx").on(table.promptVersionId),
]);

export const shoplineConnections = pgTable("shopline_connections", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  shopDomain: text("shop_domain").notNull(),
  encryptedAccessToken: text("encrypted_access_token").notNull(),
  createdAt: timestamps.createdAt,
  updatedAt: timestamps.updatedAt,
}, (table) => [
  uniqueIndex("shopline_connections_workspace_domain_uq").on(table.workspaceId, table.shopDomain),
]);

export const publishJobs = pgTable("publish_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  listingId: uuid("listing_id").references(() => listingDrafts.id, { onDelete: "cascade" }).notNull(),
  connectionId: uuid("connection_id").references(() => shoplineConnections.id).notNull(),
  status: text("status").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  remoteProductId: text("remote_product_id"),
  error: text("error"),
  createdAt: timestamps.createdAt,
  updatedAt: timestamps.updatedAt,
}, (table) => [
  uniqueIndex("publish_jobs_workspace_idempotency_uq").on(table.workspaceId, table.idempotencyKey),
  index("publish_jobs_workspace_status_idx").on(table.workspaceId, table.status),
  index("publish_jobs_listing_id_idx").on(table.listingId),
  index("publish_jobs_connection_id_idx").on(table.connectionId),
]);

export const reviewEvents = pgTable("review_events", {
  id: uuid("id").defaultRandom().primaryKey(),
  workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "cascade" }).notNull(),
  listingId: uuid("listing_id").references(() => listingDrafts.id, { onDelete: "cascade" }).notNull(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  metadata: jsonb("metadata").notNull(),
  createdAt: timestamps.createdAt,
}, (table) => [
  index("review_events_workspace_listing_idx").on(table.workspaceId, table.listingId),
  index("review_events_listing_id_idx").on(table.listingId),
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