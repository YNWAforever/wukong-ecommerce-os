import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase } from "@wukong/db";
import { MemoryAssetStore } from "@wukong/assets";
import { BULK_FORM_COLUMNS } from "@wukong/shopline";
import { writeBulkFormWorkbook } from "@wukong/shopline/bulk-form-xlsx";
import { createBulkFormImporter } from "../../../../lib/bulk-form-import";
import { approveOne } from "../../../../lib/listing-approval";
import {
  CONFIRMATION_FIELD_KEYS,
  CONFIRMATION_NEGATIVE_KEYS,
} from "../../../../lib/review-confirmation-keys";
import { buildExportReconciliation } from "../../../../lib/export-reconciliation";
import { createFreshExportVerificationService } from "../../../../lib/fresh-export-verification";
import { createExportListingsHandler } from "./route";
import { createExportDetailHandler } from "./[id]/route";
import { createExportPreviewHandler } from "./preview/route";

// Fail before opening a connection; this suite may only mutate its dedicated local database.
function guardedUrl(name: string): string {
  const value = process.env[name];
  if (process.env.WUKONG_OPAK_INTEGRATION !== "1" || !value)
    throw new Error("Explicit local delivery integration gate required");
  const parsed = new URL(value);
  if (
    !["127.0.0.1", "localhost"].includes(parsed.hostname) ||
    parsed.port !== "54329" ||
    parsed.pathname !== "/opak_fixes_delivery_20261001"
  )
    throw new Error("Dedicated loopback delivery database required");
  if (name === "TEST_DATABASE_URL" && parsed.username !== "wukong_app")
    throw new Error("Non-bypass application role required");
  return value;
}
const enabled = process.env.WUKONG_OPAK_INTEGRATION === "1";
const adminUrl = enabled ? guardedUrl("TEST_DATABASE_ADMIN_URL") : "",
  appUrl = enabled ? guardedUrl("TEST_DATABASE_URL") : "";
const admin = (
  enabled
    ? postgres(adminUrl, { max: 1, onnotice: () => undefined })
    : undefined
)!;
const database = (
  enabled ? createDatabase(appUrl, { migrationUrl: adminUrl }) : undefined
)!;
const workspaceId = "f12_" + randomUUID().replaceAll("-", ""),
  actorId = "synthetic-reviewer";
const assetStore = new MemoryAssetStore();
const sessionContext = {
  async resolve() {
    return { workspaceId, actorId, role: "reviewer" as const };
  },
};
const preview = createExportPreviewHandler({
  getDatabase: () => database,
  sessionContext,
});
const generate = createExportListingsHandler({
  getDatabase: () => database,
  getAssetStore: () => assetStore,
  sessionContext,
});
const headers = [
  BULK_FORM_COLUMNS.map((c) => c.en),
  BULK_FORM_COLUMNS.map((c) => c.zh),
];

// Merchant definition is independent of artifacts A/B. Every preserved cell has a known lexical value.
const merchant: Array<
  Record<string, string> & { productId: string; sku: string }
> = Array.from({ length: 5 }, (_, i) => {
  const row: Record<string, string> = Object.fromEntries(
    BULK_FORM_COLUMNS.map((c) => [c.key, ""]),
  );
  return {
    ...row,
    productId: "synthetic-remote-" + i,
    nameEn: "Synthetic wine " + i,
    nameZh: "Original title " + i,
    summaryEn: "Original English " + i,
    summaryZh: "Original Chinese " + i,
    seoTitleEn: "Original SEO " + i,
    seoTitleZh: "Original Chinese SEO " + i,
    seoDescriptionEn: "Original description " + i,
    seoDescriptionZh: "Original Chinese description " + i,
    seoKeywords: "original, synthetic",
    sku: "00067" + i,
    regularPrice: "00100.00",
    quantity: "06",
    updateQuantity: "+5",
    barcode: "000000123" + i,
    onlineStoreCategories: "White Wine>Germany\r\nTop Picks",
    promotionLabelEn: " line 1\nline 2 & <tag> ",
    weightKg: "00.7500",
  };
});
function merchantSheet(titles?: ReadonlyMap<string, string>) {
  return [
    ...headers.map((row) => [...row]),
    ...merchant.map((row) =>
      BULK_FORM_COLUMNS.map((c) =>
        c.key === "nameZh" && titles?.has(row.productId)
          ? titles.get(row.productId)!
          : (row[c.key] ?? ""),
      ),
    ),
  ];
}
function content(index: number, title: string) {
  return {
    sku: merchant[index]!.sku,
    producer: "Synthetic",
    productType: "wine" as const,
    country: "Germany",
    region: "Mosel",
    vintage: 2024,
    grapeVarieties: ["Riesling"],
    volumeMl: 750,
    abvPercent: 12,
    packQuantity: 1,
    priceHkd: Number(merchant[index]!.regularPrice),
    stockQuantity: 6,
    criticScores: [],
    awards: [],
    title: { en: "Synthetic wine " + index, "zh-Hant": title },
    description: {
      en: "Approved description",
      "zh-Hant": "Approved description",
    },
    seo: {
      title: { en: "Approved SEO", "zh-Hant": "Approved SEO" },
      description: {
        en: "Approved description",
        "zh-Hant": "Approved description",
      },
    },
    tags: ["approved"],
    imageAssetIds: [],
  };
}
function request(body: unknown) {
  return new Request("http://localhost/api/listings/export", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
async function select(
  ids: string[],
  repair?: {
    exportAttemptId: string;
    members: Array<{ listingId: string; resultId: string; revision: number }>;
  },
) {
  const listings = await database.forWorkspace(workspaceId, async (r) =>
    Promise.all(
      ids.map(async (listingId) => ({
        listingId,
        contentDigest: (await r.platformProducts.getByListingId(listingId))!
          .contentDigest!,
      })),
    ),
  );
  return {
    listingIds: ids,
    fields: ["nameZh"],
    attestation: { listings },
    ...(repair ? { repair } : {}),
  };
}
async function exportSelection(selection: Awaited<ReturnType<typeof select>>) {
  const before =
    await admin`select count(*)::int as n from export_attempts where workspace_id=${workspaceId}`;
  const reviewed = await preview(request(selection));
  expect(reviewed.status).toBe(200);
  const plan = await reviewed.json();
  const after =
    await admin`select count(*)::int as n from export_attempts where workspace_id=${workspaceId}`;
  expect(after[0]!.n).toBe(before[0]!.n);
  expect(plan.fields).toEqual(["nameZh"]);
  expect(
    plan.changes.every(
      (c: any) => c.column === "nameZh" && c.sourceSnapshotId && c.versionId,
    ),
  ).toBe(true);
  const response = await generate(
    request({ ...selection, previewSha256: plan.previewSha256 }),
  );
  expect({
    status: response.status,
    body: await response.clone().json(),
  }).toMatchObject({ status: 200, body: { artifactStatus: "ready" } });
  return response.json();
}
async function approve(listingId: string, index: number, title: string) {
  const version = await database.forWorkspace(workspaceId, (r) =>
    r.listings.appendVersion(
      listingId,
      content(index, title),
      { workspaceId, actorId, entityId: listingId },
      r.audit,
    ),
  );
  // Synthetic fixture setup only; product actions below use the real approval service.
  await admin`update listing_drafts set active_version_id=${version.id}, status='in_review' where workspace_id=${workspaceId} and id=${listingId}`;
  return database.forWorkspace(workspaceId, async (r) => {
    const link = (await r.platformProducts.getByListingId(listingId))!;
    const confirmation = await r.reviewConfirmations.upsert({
      listingId,
      versionId: version.id,
      fieldConfirmations: Object.fromEntries(
        CONFIRMATION_FIELD_KEYS.map((key) => [key, true]),
      ),
      negativeConfirmations: Object.fromEntries(
        CONFIRMATION_NEGATIVE_KEYS.map((key) => [key, true]),
      ),
      sourceImportId: link.sourceImportId,
      rowDigest: link.contentDigest,
    });
    return approveOne(
      listingId,
      { workspaceId, actorId, entityId: listingId },
      r,
      {
        expectedVersionId: version.id,
        confirmationLedgerRevision: confirmation.revision,
        sourceImportId: link.sourceImportId!,
        expectedRowDigest: link.contentDigest!,
      },
    );
  });
}
async function artifact(id: string) {
  return assetStore.readObject(
    workspaceId,
    `ws/${workspaceId}/exports/${id}/export-${id}.xlsx`,
  );
}
// Independent stored-ZIP/XML inspection, without the production workbook reader.
function outputRows(bytes: Uint8Array): Array<Array<string | null>> {
  const b = Buffer.from(bytes);
  let at = 0,
    xml = "";
  while (b.readUInt32LE(at) === 0x04034b50) {
    const size = b.readUInt32LE(at + 18),
      n = b.readUInt16LE(at + 26),
      extra = b.readUInt16LE(at + 28),
      start = at + 30 + n + extra;
    if (
      b.toString("utf8", at + 30, at + 30 + n) === "xl/worksheets/sheet1.xml"
    ) {
      xml = b.toString("utf8", start, start + size);
      break;
    }
    at = start + size;
  }
  expect(xml).toBeTruthy();
  return [...xml.matchAll(/<row r="[0-9]+">([\s\S]*?)<\/row>/g)].map(
    (match) => {
      const cells = Array<string | null>(71).fill(null);
      for (const cell of match[1]!.matchAll(
        /<c r="([A-Z]+)[0-9]+" t="inlineStr"><is><t xml:space="preserve">([\s\S]*?)<\/t><\/is><\/c>/g,
      )) {
        const index =
          [...cell[1]!].reduce(
            (n, char) => n * 26 + char.charCodeAt(0) - 64,
            0,
          ) - 1;
        cells[index] = cell[2]!
          .replaceAll("&#13;", "\r")
          .replaceAll("&#10;", "\n")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&");
      }
      return cells;
    },
  );
}
function assertExactMask(
  bytes: Uint8Array,
  expectedTitles: ReadonlyMap<string, string>,
) {
  const rows = outputRows(bytes);
  expect(rows.slice(0, 2)).toEqual(headers);
  expect(rows).toHaveLength(expectedTitles.size + 2);
  for (const row of rows.slice(2)) {
    const original = merchant.find((product) => product.productId === row[0])!;
    expect(original).toBeTruthy();
    expect(row[2]).toBe(expectedTitles.get(original.productId));
    for (let position = 0; position < 71; position++) {
      if (position === 2) continue;
      expect(row[position], "preserved position " + position).toBe(
        position === 39
          ? "+0"
          : original[BULK_FORM_COLUMNS[position]!.key] || null,
      );
    }
  }
}
beforeAll(async () => {
  if (!enabled) return;
  await database.migrate();
  const roles =
    await admin`select rolsuper,rolbypassrls from pg_roles where rolname='wukong_app'`;
  expect(roles[0]).toMatchObject({ rolsuper: false, rolbypassrls: false });
  const boundaries =
    await admin`select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in ('export_attempts','import_results','listing_drafts')`;
  expect(boundaries).toHaveLength(3);
  expect(
    boundaries.every((row) => row.relrowsecurity && row.relforcerowsecurity),
  ).toBe(true);
  await admin`insert into workspaces(id,name,profile) values (${workspaceId},'Synthetic F12',${admin.json({ name: "Synthetic F12", currency: "HKD", locales: ["en", "zh-Hant"], tone: "clear", claimPolicy: [], requiredFields: [] })})`;
  await admin`insert into shopline_connections(workspace_id,shop_domain,encrypted_access_token) values (${workspaceId},'synthetic.invalid','synthetic-disabled')`;
});
afterAll(async () => {
  if (enabled) {
    await database.close();
    await admin.end();
  }
});
it.skipIf(!enabled)(
  "keeps A five-row reports immutable while B repairs only its two latest rejected members, then compares an independently constructed supplied snapshot",
  async () => {
    const source = merchantSheet();
    const imported = await createBulkFormImporter({
      getDatabase: () => database,
    })({
      workspaceId,
      actorId,
      sheet: source,
      rawBytes: writeBulkFormWorkbook(source),
      merchantAttestedExportAt: new Date(),
      filename: "synthetic-five.xlsx",
      sheetName: "Default",
    });
    expect(imported.createdDrafts).toBe(5);
    const links =
      await admin`select listing_id as id, remote_product_id from platform_products where workspace_id=${workspaceId} order by remote_product_id`;
    const ids = links.map((row) => row.id as string);
    const titlesA = new Map(
      merchant.map((row, index) => [row.productId, "Approved title " + index]),
    );
    for (let i = 0; i < ids.length; i++)
      await approve(ids[i]!, i, titlesA.get(merchant[i]!.productId)!);
    const a = await exportSelection(await select(ids)),
      aBytes = await artifact(a.exportAttemptId);
    expect(a.rowCount).toBe(5);
    assertExactMask(aBytes, titlesA);
    const aAttempt = (await database.forWorkspace(workspaceId, (r) =>
      r.exportAttempts.getById(a.exportAttemptId),
    ))!;
    const reports = await database.forWorkspace(workspaceId, async (r) => {
      const values = [];
      for (const [index, listingId] of ids.entries())
        values.push(
          await r.importResults.create({
            mode: "export",
            listingId,
            exportAttemptId: a.exportAttemptId,
            versionId: aAttempt.manifest.find(
              (member) => member.listingId === listingId,
            )!.versionId!,
            idempotencyKey: randomUUID(),
            outcome: index < 3 ? "accepted" : "rejected",
            rejectReason: index < 3 ? null : "Synthetic merchant rejection",
            recordedBy: actorId,
          }),
        );
      return values;
    });
    expect(buildExportReconciliation(aAttempt, reports).counts).toMatchObject({
      included: 5,
      accepted: 3,
      rejected: 2,
      unreported: 0,
    });
    const rejected = reports.slice(3),
      repair = {
        exportAttemptId: a.exportAttemptId,
        members: rejected.map((result) => ({
          listingId: result.listingId,
          resultId: result.id,
          revision: result.revision,
        })),
      };
    const illegal = {
      ...repair,
      members: [
        {
          listingId: reports[0]!.listingId,
          resultId: reports[0]!.id,
          revision: reports[0]!.revision,
        },
      ],
    };
    expect(
      (await preview(request(await select([ids[0]!], illegal)))).status,
    ).toBe(409);
    for (const row of merchant.slice(3)) row.regularPrice = "00105.00";
    const newSource = [
      ...headers,
      ...merchant
        .slice(3)
        .map((row) => BULK_FORM_COLUMNS.map((column) => row[column.key] ?? "")),
    ];
    const reimported = await createBulkFormImporter({
      getDatabase: () => database,
    })({
      workspaceId,
      actorId,
      sheet: newSource,
      rawBytes: writeBulkFormWorkbook(newSource),
      merchantAttestedExportAt: new Date(),
      filename: "synthetic-rejected-current-source.xlsx",
      sheetName: "Default",
    });
    expect(reimported.refreshedProducts).toBe(2);
    expect(reimported.invalidatedApprovals).toBe(2);
    const observedResponse = await createExportDetailHandler({
      getDatabase: () => database,
      sessionContext,
    })(new Request("http://localhost"), {
      params: Promise.resolve({ id: a.exportAttemptId }),
    });
    expect(observedResponse.status).toBe(200);
    const currentDetail = await observedResponse.json();
    expect(currentDetail.attempt.sourceAttestation).toEqual(
      aAttempt.sourceAttestation,
    );
    expect(currentDetail.repairSourceObservations).toHaveLength(2);
    for (const observation of currentDetail.repairSourceObservations) {
      expect(observation.sourceImportId).toBe(reimported.sourceImportId);
      expect(observation.contentDigest).not.toBe(
        aAttempt.sourceAttestation!.find(
          (entry) => entry.listingId === observation.listingId,
        )!.contentDigest,
      );
    }
    const titlesB = new Map(
      merchant
        .slice(3)
        .map((row, index) => [row.productId, "Repaired title " + (index + 3)]),
    );
    for (let i = 3; i < ids.length; i++)
      await approve(ids[i]!, i, titlesB.get(merchant[i]!.productId)!);
    const bSelection = await select(ids.slice(3), repair),
      reviewedB = await (await preview(request(bSelection))).json();
    // Changing an exact latest rejection after review fences that stale generation.
    let releaseLock!: () => void, reportLocked!: () => void;
    const heldUntilReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const locked = new Promise<void>((resolve) => {
      reportLocked = resolve;
    });
    const held = database.forWorkspace(workspaceId, async (r) => {
      await r.importResults.assertRejectedForRepair(repair);
      reportLocked();
      await heldUntilReleased;
    });
    await locked;
    const correctionName = "f12_correction_" + randomUUID().replaceAll("-", "");
    const correctionUrl = new URL(appUrl);
    correctionUrl.searchParams.set("application_name", correctionName);
    const correctionDb = createDatabase(correctionUrl.toString(), {
      maxConnections: 1,
    });
    const correction = correctionDb
      .forWorkspace(workspaceId, (r) =>
        r.importResults.create({
          mode: "export",
          listingId: rejected[0]!.listingId,
          exportAttemptId: a.exportAttemptId,
          versionId: rejected[0]!.versionId!,
          idempotencyKey: randomUUID(),
          outcome: "rejected",
          rejectReason: "Synthetic corrected rejection",
          recordedBy: actorId,
          supersedesResultId: rejected[0]!.id,
          correctionReason: "Synthetic correction",
        }),
      )
      .then(
        (result) => ({ result }),
        (error) => ({ error }),
      );
    let observedBlocked = false;
    try {
      for (let tries = 0; tries < 100; tries++) {
        const state =
          await admin`select wait_event_type from pg_stat_activity where application_name=${correctionName} and state='active'`;
        if (state.some((row) => row.wait_event_type === "Lock")) {
          observedBlocked = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(
        observedBlocked,
        "actual receipt correction must wait for the repair authority lock",
      ).toBe(true);
    } finally {
      releaseLock();
      await held;
    }
    const correctedOutcome = await correction;
    await correctionDb.close();
    if ("error" in correctedOutcome) throw correctedOutcome.error;
    const corrected = correctedOutcome.result;
    const stale = await generate(
      request({ ...bSelection, previewSha256: reviewedB.previewSha256 }),
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "repair_result_changed" });
    repair.members[0] = {
      listingId: corrected.listingId,
      resultId: corrected.id,
      revision: corrected.revision,
    };
    const b = await exportSelection(await select(ids.slice(3), repair)),
      bBytes = await artifact(b.exportAttemptId);
    expect(b.rowCount).toBe(2);
    expect(b.exportAttemptId).not.toBe(a.exportAttemptId);
    assertExactMask(bBytes, titlesB);
    const bAttempt = (await database.forWorkspace(workspaceId, (r) =>
      r.exportAttempts.getById(b.exportAttemptId),
    ))!;
    expect(bAttempt.provenance).toMatchObject({
      fields: ["nameZh"],
      repairOf: repair,
    });
    expect(buildExportReconciliation(bAttempt, []).counts).toMatchObject({
      included: 2,
      accepted: 0,
      rejected: 0,
      unreported: 2,
    });
    const aAfter = (await database.forWorkspace(workspaceId, (r) =>
      r.exportAttempts.getById(a.exportAttemptId),
    ))!;
    expect(aAfter).toEqual(aAttempt);
    expect(await artifact(a.exportAttemptId)).toEqual(aBytes);
    const currentReports = await database.forWorkspace(workspaceId, (r) =>
      r.importResults.listForExportAttempts([a.exportAttemptId]),
    );
    expect(
      buildExportReconciliation(aAfter, currentReports).counts,
    ).toMatchObject({ accepted: 3, rejected: 2 });
    expect(
      currentReports
        .filter((result) => result.revision === 1)
        .map((result) => result.id)
        .sort(),
    ).toEqual(reports.map((result) => result.id).sort());
    expect(
      await database.forWorkspace("f12_foreign_" + randomUUID(), (r) =>
        r.exportAttempts.getById(b.exportAttemptId),
      ),
    ).toBeNull();
    const foreignPreview = createExportPreviewHandler({
      getDatabase: () => database,
      sessionContext: {
        async resolve() {
          return {
            workspaceId: "f12_foreign_" + randomUUID(),
            actorId,
            role: "reviewer",
          };
        },
      },
    });
    expect(
      (await foreignPreview(request(await select(ids.slice(3), repair))))
        .status,
    ).toBe(404);
    const allMerchantTitles = new Map([...titlesA, ...titlesB]);
    // Reconstruct from merchant definition and expected accepted/repair titles, never read A/B into the supplied workbook.
    const supplied = writeBulkFormWorkbook(merchantSheet(allMerchantTitles));
    const attestedAt = new Date();
    expect(attestedAt.getTime()).toBeGreaterThan(
      bAttempt.artifactReadyAt!.getTime(),
    );
    const comparison = await createFreshExportVerificationService({
      getDatabase: () => database,
      getAssetStore: () => assetStore,
    }).record({
      workspaceId,
      actorId,
      exportAttemptId: b.exportAttemptId,
      filename: "independent-synthetic-merchant.xlsx",
      merchantAttestedExportAt: attestedAt.toISOString(),
      sameStoreAttested: true,
      body: supplied,
    });
    expect(comparison.verification.comparison).toMatchObject({
      outcome: "matches_compared_fields",
      counts: { expected: 2, matched: 2, unrelatedRows: 3, suppliedRows: 5 },
    });
    expect(comparison.verification.suppliedSha256).not.toBe(
      bAttempt.artifactSha256,
    );
    expect(buildExportReconciliation(bAttempt, []).verificationStatus).toBe(
      "unverified",
    );
  },
);
