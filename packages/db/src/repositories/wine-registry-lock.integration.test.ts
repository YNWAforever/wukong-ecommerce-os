import postgres from "postgres";
import { randomUUID } from "node:crypto";
import { afterAll, expect, it } from "vitest";
import { createDatabase } from "../index.js";
const url = process.env.TEST_DATABASE_URL!;
if (
  !url ||
  new URL(url).hostname !== "127.0.0.1" ||
  !url.endsWith("/wukong_wine_sdd")
)
  throw Error("dedicated fixture required");
const db = createDatabase(url),
  admin = postgres(process.env.TEST_DATABASE_ADMIN_URL!, {
    onnotice: () => {},
  });
afterAll(async () => {
  await db.close();
  await admin.end();
});
it("registry lock preserves workspace FK key-share compatibility and tenant independence", async () => {
  const ws = `wine-registry-lock-${randomUUID()}`,
    other = `wine-registry-lock-${randomUUID()}`;
  await db.forWorkspace(ws, async (r) => {
    await r.listings.create({ target: "shopline" });
  });
  await db.forWorkspace(other, async (r) => {
    await r.listings.create({ target: "shopline" });
  });
  await db.forWorkspace(ws, async (r) => {
    expect(typeof r.wineEnrichment.lockAuthorities).toBe("function");
    await r.wineEnrichment.lockAuthorities();
    // This separate transaction completes while the registry lock remains held: NKU must permit FK KEY SHARE.
    const rows = await admin.begin(
      (tx) => tx`select id from workspaces where id=${ws} for key share`,
    );
    expect(rows[0]!.id).toBe(ws);
    await db.forWorkspace(other, async (otherRepos) => {
      await otherRepos.wineEnrichment.lockAuthorities();
      expect(await otherRepos.wineEnrichment.readAuthorities()).toEqual([]);
    });
    expect(await r.wineEnrichment.readAuthorities()).toEqual([]);
  });
});
it("registry lock is released on rollback and does not weaken authenticated review", async () => {
  const ws = `wine-registry-lock-${randomUUID()}`;
  await db.forWorkspace(ws, async (r) => {
    await r.listings.create({ target: "shopline" });
  });
  await expect(
    db.forWorkspace(ws, async (r) => {
      await r.wineEnrichment.lockAuthorities();
      throw Error("fixture rollback");
    }),
  ).rejects.toThrow("fixture rollback");
  await db.forWorkspace(ws, async (r) => {
    await r.wineEnrichment.lockAuthorities();
    await expect(
      r.wineEnrichment.recordReviewedAuthority("not-a-member", {
        schemaVersion: 1,
        domain: "wine.test",
        subject: { kind: "producer", name: "Fixture Estate" },
        proofUrl: "https://wine.test/about",
        proofDigest: "a".repeat(64),
        verifiedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
        revokedAt: null,
        verifierId: "not-a-member",
      }),
    ).rejects.toThrow("authorized reviewer required");
    expect(await r.wineEnrichment.readAuthorities()).toEqual([]);
  });
});
