import { it, expect } from "vitest";
import {
  scanCopyWithClaimSupport,
  renderExternalClaim,
} from "./copy-claim-support.js";
const claim = {
  kind: "rating" as const,
  critic: "Robert Parker",
  value: "95",
  scale: "100",
  year: 2022,
  product: {
    producer: "Maker",
    productName: "Cuvee A",
    vintage: 2020,
    volumeMl: 750,
    packQuantity: 1,
    marketVariant: "HK",
  },
};
it("only removes the exact accepted claim from rating checks, preserving unrelated claims and health rules", () => {
  const text = renderExternalClaim(claim, "en"),
    support = { field: "descriptionEn", text };
  expect(
    scanCopyWithClaimSupport(
      { descriptionEn: text },
      { criticScores: [], awards: [] },
      [support],
    ),
  ).toEqual([]);
  expect(
    scanCopyWithClaimSupport(
      { descriptionEn: text + " Wine Spectator 100 points" },
      { criticScores: [], awards: [] },
      [support],
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ rule: "rating_without_evidence" }),
    ]),
  );
  expect(
    scanCopyWithClaimSupport(
      { descriptionEn: text + " health benefit" },
      { criticScores: [], awards: [] },
      [support],
    ),
  ).toEqual(
    expect.arrayContaining([expect.objectContaining({ rule: "health_claim" })]),
  );
  expect(
    scanCopyWithClaimSupport(
      { descriptionEn: text.replace("95", "100") },
      { criticScores: [], awards: [] },
      [support],
    ),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ rule: "rating_without_evidence" }),
    ]),
  );
});
