import { describe, expect, it } from "vitest";
import {
  initialMaintenanceIntent,
  maintenanceDestination,
  matchMaintenanceCandidate,
} from "./catalog-maintenance-intent";
const raw = {
  productId: "remote_1",
  variantId: null,
  nameEn: "SYN Estate 2020 750ml 6 bottles",
  sku: "000674",
};
const input = {
  connectionId: "store_1",
  expectedConnectionId: "store_1",
  referenceRaw: raw,
  currentRaw: raw,
};
describe("catalog maintenance intent and candidate identity", () => {
  it("restores a workbench scan into its reference preview without enabling maintenance", () => {
    expect(initialMaintenanceIntent({ scan: "synthetic-scan" })).toBe(
      "reference-only",
    );
    expect(
      initialMaintenanceIntent({
        scan: "synthetic-scan",
        intent: "maintain-existing",
      }),
    ).toBe("maintain-existing");
    expect(initialMaintenanceIntent({})).toBe("maintain-existing");
    expect(initialMaintenanceIntent({ intent: "reference-only" })).toBe(
      "reference-only",
    );
  });
  it("routes a new draft to the existing editable intake and keeps reference intent explicit", () => {
    expect(maintenanceDestination("new-draft")).toBe("/listings/new");
    expect(maintenanceDestination("reference-only")).toBe(
      "/listings/import?intent=reference-only",
    );
  });
  it("accepts exact store/product identity with matching observed year/volume/pack", () =>
    expect(matchMaintenanceCandidate(input)).toMatchObject({
      state: "matched",
      reasons: [],
    }));
  it.each([
    { expectedConnectionId: "other_store" },
    { currentRaw: { ...raw, productId: "other_remote" } },
    { currentRaw: { ...raw, variantId: "variant_1" } },
    { currentRaw: { ...raw, nameEn: "SYN Estate 2021 750ml 6 bottles" } },
    { currentRaw: { ...raw, nameEn: "SYN Estate 2020 375ml 6 bottles" } },
    { currentRaw: { ...raw, nameEn: "SYN Estate 2020 750ml 1 bottle" } },
  ])(
    "blocks a conflicting identity independently of SKU/name hints (%j)",
    (change) =>
      expect(matchMaintenanceCandidate({ ...input, ...change })).toMatchObject({
        state: "blocked",
      }),
  );
  it("requires explicit human confirmation when facts or source store/product identity are unknown", () => {
    expect(
      matchMaintenanceCandidate({
        ...input,
        referenceRaw: { nameEn: "SYN Estate", sku: "000674" },
      }),
    ).toMatchObject({ state: "confirmation_required" });
    expect(
      matchMaintenanceCandidate({
        ...input,
        referenceRaw: { ...raw, sku: "different" },
      }),
    ).toMatchObject({ state: "confirmation_required" });
  });
  it("handles NV and unit conversion without inventing a year or a one-bottle pack", () => {
    const nv = { ...raw, nameEn: "SYN Estate NV 75cl 6 bottles" };
    expect(
      matchMaintenanceCandidate({
        ...input,
        referenceRaw: nv,
        currentRaw: { ...nv, nameEn: "SYN Estate NV 750ml 6 bottles" },
      }),
    ).toMatchObject({ state: "matched" });
    expect(
      matchMaintenanceCandidate({
        ...input,
        referenceRaw: { ...raw, nameEn: "SYN Estate 2020 750ml" },
        currentRaw: { ...raw, nameEn: "SYN Estate 2020 750ml" },
      }),
    ).toMatchObject({
      state: "confirmation_required",
      reasons: expect.arrayContaining(["pack_unknown"]),
    });
  });
  it("blocks contradictory bilingual observations rather than treating them as absent", () => {
    expect(
      matchMaintenanceCandidate({
        ...input,
        referenceRaw: { ...raw, nameZh: "SYN Estate 2021 375ml 1 bottle" },
      }),
    ).toMatchObject({
      state: "blocked",
      reasons: expect.arrayContaining([
        "year_ambiguous",
        "volume_ambiguous",
        "pack_ambiguous",
      ]),
    });
  });
  it.each([{ vintage: "2021" }, { volumeMl: "375" }, { packQuantity: "1" }])(
    "blocks a known structured website conflict (%j)",
    (attributes) => {
      expect(
        matchMaintenanceCandidate({
          ...input,
          referenceRaw: {
            productId: raw.productId,
            sku: raw.sku,
            nameEn: "SYN Estate",
            ...attributes,
          },
        }),
      ).toMatchObject({ state: "blocked" });
    },
  );
});
