import { describe, expect, it } from "vitest";
import { wineIdentity } from "./wine-enrichment-fixtures.js";
import { matchWineIdentity } from "./wine-identity-match.js";

const observation = (value: string | number) => ({
  value,
  state: "observed" as const,
  evidenceIds: ["00000000-0000-4000-8000-000000000001"],
});
describe("exact wine identity", () => {
  it("matches normalized names using the legacy strict normalization", () => {
    expect(
      matchWineIdentity(
        wineIdentity(),
        wineIdentity({
          producer: "  FIXTURE  ESTATE ",
          productName: "Ｒｅｓｅｒｖｅ Red",
        }),
      ).state,
    ).toBe("matched");
  });
  it("rejects a different vintage despite matching producer and name", () => {
    expect(
      matchWineIdentity(
        wineIdentity({ vintage: { state: "known", year: 2019 } }),
        wineIdentity({ vintage: { state: "known", year: 2020 } }),
      ),
    ).toEqual({ state: "mismatch", reasons: ["vintage_conflict"] });
  });
  it.each(["producer", "productName"] as const)(
    "requires %s on both identities",
    (field) => {
      expect(
        matchWineIdentity(wineIdentity(), wineIdentity({ [field]: null }))
          .state,
      ).toBe("ambiguous");
      expect(
        matchWineIdentity(wineIdentity({ [field]: null }), wineIdentity())
          .state,
      ).toBe("ambiguous");
    },
  );
  it("does not confuse two names under one producer", () => {
    expect(
      matchWineIdentity(
        wineIdentity(),
        wineIdentity({ productName: "Reserve White" }),
      ).reasons,
    ).toContain("productName_conflict");
  });
  it("does not infer NV from unknown", () => {
    expect(
      matchWineIdentity(
        wineIdentity({ vintage: { state: "not_applicable", year: null } }),
        wineIdentity(),
      ).state,
    ).toBe("ambiguous");
  });
  it.each([
    "volumeMl",
    "packQuantity",
    "marketVariant",
    "barcode",
    "cuvee",
    "abvPercent",
  ] as const)("checks known %s and missing candidate values", (field) => {
    const a = ["volumeMl", "packQuantity", "abvPercent"].includes(field)
      ? 700
      : "one";
    const b = typeof a === "number" ? 750 : "two";
    expect(
      matchWineIdentity(
        wineIdentity({ [field]: a }),
        wineIdentity({ [field]: b }),
      ).reasons,
    ).toContain(`${field}_conflict`);
    expect(
      matchWineIdentity(wineIdentity({ [field]: a }), wineIdentity()).reasons,
    ).toContain(`${field}_missing`);
  });
  it.each(["ageYears", "caskType", "batch"])("checks spirit %s", (field) => {
    const a = wineIdentity({
      kind: "spirits",
      category: { [field]: observation("one") },
    });
    const b = wineIdentity({
      kind: "spirits",
      category: { [field]: observation("two") },
    });
    expect(matchWineIdentity(a, b).reasons).toContain(`${field}_conflict`);
    expect(matchWineIdentity(a, wineIdentity({ kind: "spirits" })).state).toBe(
      "ambiguous",
    );
  });
  it("does not trust model-provided aliases", () => {
    expect(
      matchWineIdentity(
        wineIdentity(),
        wineIdentity({ productName: "Other", aliases: ["Reserve Red"] }),
      ).state,
    ).toBe("mismatch");
  });
  it("uses only producer-scoped verified aliases", () => {
    const candidate = wineIdentity({ productName: "珍藏紅酒" });
    const verifiedAliases = [
      {
        producer: "Fixture Estate",
        canonicalName: "Reserve Red",
        alias: "珍藏紅酒",
      },
    ];
    expect(
      matchWineIdentity(wineIdentity(), candidate, { verifiedAliases }).state,
    ).toBe("matched");
    expect(
      matchWineIdentity(wineIdentity(), candidate, {
        verifiedAliases: [{ ...verifiedAliases[0]!, producer: "Other" }],
      }).state,
    ).toBe("mismatch");
  });
  it("keeps unresolved observation conflicts ambiguous", () => {
    const a = wineIdentity();
    a.observations.producer!.state = "conflict";
    expect(matchWineIdentity(a, wineIdentity()).state).toBe("ambiguous");
  });
});
