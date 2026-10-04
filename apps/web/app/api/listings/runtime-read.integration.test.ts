import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDatabase,
  loadSqlMigrations,
  inspectListingReadCompatibility,
} from "@wukong/db";
import { pathToFileURL } from "node:url";
import { sep } from "node:path";
import { emptyWorkingListing } from "@wukong/core";
import { createListListingsHandler } from "./route";
import { createListingViewHandler } from "./[id]/route";
import { createCatalogHandler } from "../catalog/route";

const adminUrl = process.env.TEST_DATABASE_ADMIN_URL!;
const appUrl = process.env.TEST_DATABASE_URL!;
// This suite intentionally corrupts one synthetic version and changes a table
// grant. It must never run against a remote database or a user's default DB.
const enabled = process.env.WUKONG_OPAK_INTEGRATION === "1";
if (enabled)
  for (const url of [adminUrl, appUrl]) {
    const parsed = new URL(url);
    if (
      !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
      !parsed.pathname.startsWith("/opak_fixes_")
    )
      throw new Error(
        "runtime read regression requires task-owned loopback database",
      );
  }
const workspaceId = "ws_runtime_read_synthetic";
const foreignWorkspaceId = "ws_runtime_read_foreign";
const ids = Array.from({ length: 5 }, () => randomUUID());
const normalIds = ids.slice(0, 3);
const malformedId = ids[3]!;
const noVersionId = ids[4]!;
let admin: ReturnType<typeof postgres>;
let database: ReturnType<typeof createDatabase>;
const profile = {
  name: "Synthetic workspace",
  currency: "HKD",
  locales: ["en", "zh-Hant"],
  tone: "clear",
  claimPolicy: [],
  requiredFields: [],
  brandBackgroundColor: null,
};
const content = {
  ...emptyWorkingListing(),
  sku: "000674",
  packQuantity: 1,
  title: { en: "SYN Test 2020", "zh-Hant": "SYN 測試 2020" },
  description: { en: "Synthetic summary", "zh-Hant": "合成摘要" },
  seo: {
    title: { en: "Synthetic SEO", "zh-Hant": "合成 SEO" },
    description: { en: "Synthetic SEO summary", "zh-Hant": "合成 SEO 摘要" },
  },
};
const session = (scope = workspaceId) => ({
  async resolve() {
    return {
      workspaceId: scope,
      actorId: "synthetic_operator",
      role: "operator" as const,
    };
  },
});
const detail = (scope = workspaceId) =>
  createListingViewHandler({
    sessionContext: session(scope),
    getDatabase: () => database,
    getAssetStore: () => ({
      async createReadUrl() {
        throw new Error("unexpected synthetic asset request");
      },
    }),
  });
const queue = () =>
  createListListingsHandler({
    sessionContext: session(),
    getDatabase: () => database,
  });
const readDetail = (id: string, scope?: string) =>
  detail(scope)(new Request("http://local/api/listings/" + id), {
    params: Promise.resolve({ id }),
  });

describe.skipIf(!enabled)(
  "runtime read resilience with real RLS repositories",
  () => {
    beforeAll(async () => {
      admin = postgres(adminUrl, {
        max: 1,
        prepare: false,
        onnotice: () => {},
      });
      database = createDatabase(appUrl, { migrationUrl: adminUrl });
      await database.migrate();
      const [role] =
        await admin`select rolsuper, rolbypassrls from pg_roles where rolname='wukong_app'`;
      expect(role).toMatchObject({ rolsuper: false, rolbypassrls: false });
      await admin`insert into workspaces (id,name,profile) values
      (${workspaceId},'Synthetic workspace',${admin.json(profile)}),
      (${foreignWorkspaceId},'Synthetic foreign workspace',${admin.json(profile)})`;
      for (const id of ids) {
        await admin`insert into listing_drafts (id,workspace_id,target,status,note)
        values (${id},${workspaceId},'shopline',${id === noVersionId ? "needs_info" : "in_review"},'Synthetic note')`;
        if (id === noVersionId) continue;
        const versionId = randomUUID();
        const value =
          id === malformedId ? { ...content, title: null } : content;
        await admin`insert into listing_versions (id,workspace_id,listing_id,sequence,content,created_by)
        values (${versionId},${workspaceId},${id},1,${admin.json(value)},'synthetic_operator')`;
        await admin`update listing_drafts set active_version_id=${versionId} where id=${id}`;
      }
    });
    afterAll(async () => {
      await admin`delete from workspaces where id in (${workspaceId},${foreignWorkspaceId})`;
      await database.close();
      await admin.end();
    });

    it("preserves three healthy rows and a visible blocked row when one active version is malformed", async () => {
      const response = await queue()(new Request("http://local/api/listings"));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.totalMatching).toBe(5);
      expect(body.items.map((item: { id: string }) => item.id).sort()).toEqual(
        [...ids].sort(),
      );
      for (const id of normalIds)
        expect(
          body.items.find((item: { id: string }) => item.id === id),
        ).toMatchObject({ readState: "ready", sku: "000674" });
      const blocked = body.items.find(
        (item: { id: string }) => item.id === malformedId,
      );
      expect(blocked).toMatchObject({
        readState: "blocked",
        reviewContext: null,
        sourceReadiness: null,
        readFailure: {
          reason: "invalid_active_version",
          requestId: expect.any(String),
        },
      });
      expect(blocked).not.toHaveProperty("content");
    });
    it("fails readiness for an actual admin connection while the runtime connection is safe", async () => {
      expect(
        await inspectListingReadCompatibility((sql) => admin.unsafe(sql)),
      ).toMatchObject({
        ready: false,
        missing: ["0046.effective_runtime_role"],
      });
      expect(await database.inspectListingReadCompatibility!()).toMatchObject({
        ready: true,
      });
    });
    it("isolates real malformed catalog hydration but fails a global platform-table permission fault", async () => {
      const connectionId = randomUUID();
      const badId = randomUUID();
      const goodId = randomUUID();
      const handler = createCatalogHandler({
        sessionContext: session(),
        getDatabase: () => database,
      });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await admin`insert into shopline_connections(id,workspace_id,shop_domain,encrypted_access_token) values (${connectionId},${workspaceId},'synthetic.invalid','disabled')`;
        await admin`insert into platform_products(id,workspace_id,connection_id,remote_product_id,origin,listing_id,facts_prefill) values
        (${badId},${workspaceId},${connectionId},'synthetic-bad','created',${normalIds[0]!},'{"volumeMl":"bad"}'::jsonb),
        (${goodId},${workspaceId},${connectionId},'synthetic-good','created',${noVersionId},null)`;
        const response = await handler(
          new Request("http://local/api/catalog?filter=bound"),
        );
        expect(response.status, JSON.stringify(log.mock.calls)).toBe(200);
        const body = await response.json();
        expect(body.items).toHaveLength(2);
        expect(body.items.find((r: any) => r.id === badId)).toMatchObject({
          readState: "blocked",
          sourceReadiness: null,
          supportRequestId: expect.any(String),
        });
        expect(body.items.find((r: any) => r.id === goodId)).toMatchObject({
          readState: "ready",
        });
        expect(
          (
            await createCatalogHandler({
              sessionContext: session(foreignWorkspaceId),
              getDatabase: () => database,
            })(new Request("http://local/api/catalog?filter=bound"))
          ).status,
        ).toBe(200);
        await admin.unsafe(
          "REVOKE SELECT ON platform_products FROM wukong_app",
        );
        const failed = await handler(
          new Request("http://local/api/catalog?filter=bound"),
        );
        expect(failed.status).toBe(500);
        expect(await failed.json()).not.toHaveProperty("items");
      } finally {
        await admin.unsafe("GRANT SELECT ON platform_products TO wukong_app");
        await admin`delete from shopline_connections where id=${connectionId}`;
        log.mockRestore();
      }
    });

    it("returns a safe blocked identity instead of losing the malformed listing's support path", async () => {
      const response = await readDetail(malformedId);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        listingId: malformedId,
        readState: "blocked",
        activeVersion: null,
        permissions: {
          canApprove: false,
          canDeliver: false,
          canEdit: false,
          canProcess: false,
        },
      });
      expect(body.readFailure.requestId).toBe(
        response.headers.get("x-request-id"),
      );
    });

    it("keeps a legitimate no-version draft available for manual input", async () => {
      const response = await readDetail(noVersionId);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toMatchObject({
        readState: "ready",
        activeVersion: null,
        permissions: { canEdit: true },
        workingInput: {
          revision: 0,
          workingContent: { volumeMl: null, sku: null },
        },
      });
      expect(body.sourceReadiness.eligible).toBe(false);
    });

    it("does not expose a foreign-workspace listing even when its version is malformed", async () => {
      const response = await readDetail(malformedId, foreignWorkspaceId);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        code: "listing_not_found",
        requestId: expect.any(String),
      });
    });

    it("propagates a real table-permission fault as a correlated overall failure, not blocked rows or an empty list", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        await admin.unsafe("REVOKE SELECT ON listing_versions FROM wukong_app");
        const response = await queue()(
          new Request("http://local/api/listings"),
        );
        expect(response.status).toBe(500);
        const body = await response.json();
        expect(body).not.toHaveProperty("items");
        expect(body.requestId).toBe(response.headers.get("x-request-id"));
        const lines = log.mock.calls.map(([line]) => JSON.parse(String(line)));
        expect(lines).toContainEqual(
          expect.objectContaining({
            requestId: body.requestId,
            stage: "listing",
            code: "permission_denied",
          }),
        );
        expect(JSON.stringify(lines)).not.toMatch(
          /Synthetic|000674|select |postgres:\/\//i,
        );
      } finally {
        await admin.unsafe("GRANT SELECT ON listing_versions TO wukong_app");
        log.mockRestore();
      }
    });

    it("diagnoses the production-observed missing source columns in both routes and verifies the reviewed additive repair", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const migrations = await loadSqlMigrations(
        process.env.DATABASE_MIGRATIONS_DIR
          ? pathToFileURL(process.env.DATABASE_MIGRATIONS_DIR + sep)
          : new URL("../../../../../packages/db/drizzle/", import.meta.url),
      );
      const repair = migrations.find(
        (migration) =>
          migration.name === "0046_listing_version_source_binding.sql",
      )!;
      const before =
        await admin`select id,md5(content::text) as digest from listing_versions where workspace_id=${workspaceId} order by id`;
      expect((await database.inspectListingReadCompatibility!()).ready).toBe(
        true,
      );
      try {
        await admin.unsafe(
          "ALTER TABLE listing_versions DROP COLUMN source_import_id, DROP COLUMN source_row_digest",
        );
        expect(await database.inspectListingReadCompatibility!()).toMatchObject(
          {
            ready: false,
            missing: expect.arrayContaining([
              "0046.source_import_column",
              "0046.source_digest_column",
              "0046.source_binding_fk",
            ]),
          },
        );
        for (const [stage, response] of [
          ["listing", await readDetail(normalIds[0]!)],
          ["sources", await queue()(new Request("http://local/api/listings"))],
        ] as const) {
          expect(response.status).toBe(500);
          const body = await response.json();
          expect(body).not.toHaveProperty("items");
          expect(body.requestId).toMatch(/^[a-f0-9-]{36}$/);
          expect(body.requestId).toBe(response.headers.get("x-request-id"));
          expect(
            log.mock.calls.map(([line]) => JSON.parse(String(line))),
          ).toContainEqual(
            expect.objectContaining({
              requestId: body.requestId,
              stage,
              code: "schema_unavailable",
            }),
          );
        }
      } finally {
        await admin.unsafe(repair.sql);
        log.mockRestore();
      }
      expect((await database.inspectListingReadCompatibility!()).ready).toBe(
        true,
      );
      expect(
        await admin`select id,md5(content::text) as digest from listing_versions where workspace_id=${workspaceId} order by id`,
      ).toEqual(before);
      expect((await readDetail(normalIds[0]!)).status).toBe(200);
      expect(
        (await queue()(new Request("http://local/api/listings"))).status,
      ).toBe(200);
    });
  },
);
