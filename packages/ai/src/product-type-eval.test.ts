/**
 * The scorer has to be trustworthy before its score means anything.
 *
 * D1 removed the only automatic check on `productType` -- grounding could not
 * police a classification without a knowledge base -- and said accuracy was now
 * an eval concern. An eval nobody has tested is not a measurement, so these
 * cases pin the ways a scorer flatters a classifier: counting an empty set as
 * perfect, hiding a wholly-failed class behind a good average, and treating
 * "I don't know" as just another wrong answer.
 */
import { describe, expect, it } from "vitest";

import {
  assertClassificationEvaluation,
  evaluateProductTypeClassification,
  PRODUCT_TYPE_GOLDEN_SET,
  PRODUCT_TYPES,
  type ProductType,
  type ProductTypeCase,
} from "./product-type-eval.js";

/** A classifier that is simply right, to prove a passing run is reachable. */
const perfect = (excerpt: string): ProductType =>
  PRODUCT_TYPE_GOLDEN_SET.find((testCase) => testCase.excerpt === excerpt)
    ?.expected ?? "other";

describe("the golden set itself", () => {
  it("covers every value the schema allows", () => {
    // A class with no case is a class nobody is measuring.
    const covered = new Set(
      PRODUCT_TYPE_GOLDEN_SET.map((testCase) => testCase.expected),
    );

    expect([...covered].sort()).toEqual([...PRODUCT_TYPES].sort());
  });

  it("gives every case a distinct id and a reason for existing", () => {
    const ids = PRODUCT_TYPE_GOLDEN_SET.map((testCase) => testCase.id);

    expect(new Set(ids).size).toBe(ids.length);
    for (const testCase of PRODUCT_TYPE_GOLDEN_SET) {
      expect(testCase.probes.length).toBeGreaterThan(10);
      expect(testCase.excerpt.trim()).not.toBe("");
    }
  });

  it("never prints the answer in the excerpt", () => {
    // The whole reason productType is `classified` rather than `verbatim`: if a
    // case could be solved by searching the excerpt for its own answer, it would
    // be testing string matching, not classification.
    for (const testCase of PRODUCT_TYPE_GOLDEN_SET) {
      expect(testCase.excerpt.toLowerCase()).not.toContain(testCase.expected);
    }
  });

  it("keeps the traps that a plausible reading gets wrong", () => {
    // Named explicitly so deleting one is a visible decision rather than a
    // quiet loss of coverage.
    const ids = PRODUCT_TYPE_GOLDEN_SET.map((testCase) => testCase.id);

    expect(ids).toEqual(
      expect.arrayContaining([
        "spirits-baijiu-chinese",
        "spirits-cognac",
        "wine-port-fortified",
        "other-umeshu",
      ]),
    );
  });
});

describe("evaluateProductTypeClassification", () => {
  it("scores a correct classifier as passing", () => {
    const report = evaluateProductTypeClassification(
      PRODUCT_TYPE_GOLDEN_SET,
      perfect,
    );

    expect(report.passed).toBe(true);
    expect(report.accuracy).toBe(1);
    expect(report.failures).toEqual([]);
    expect(() => assertClassificationEvaluation(report)).not.toThrow();
  });

  it("reports which case failed and what it was probing", () => {
    // A bare score tells nobody what to fix. The trap's description travels
    // with the failure so the report explains itself.
    const alwaysWine = (): ProductType => "wine";

    const report = evaluateProductTypeClassification(
      PRODUCT_TYPE_GOLDEN_SET,
      alwaysWine,
    );

    expect(report.passed).toBe(false);
    const baijiu = report.failures.find(
      (failure) => failure.id === "spirits-baijiu-chinese",
    );
    expect(baijiu).toMatchObject({ expected: "spirits", actual: "wine" });
    expect(baijiu?.probes).toMatch(/baijiu/i);
  });

  it("refuses to call an empty set perfect", () => {
    // Nothing to check must never read as a pass. This is how an eval that has
    // silently stopped loading its cases reports green for ever.
    const report = evaluateProductTypeClassification([], perfect);

    expect(report.accuracy).toBe(0);
    expect(report.passed).toBe(false);
    expect(() => assertClassificationEvaluation(report)).toThrow(
      /no cases were scored/,
    );
  });

  it("counts a declined answer apart from a wrong one", () => {
    // "I don't know" and "it's wine" are different failures: one is a model
    // that needs more of the label, the other is a model that is confident and
    // incorrect. Collapsing them loses the distinction that decides what to do.
    const declines = () => null;

    const report = evaluateProductTypeClassification(
      PRODUCT_TYPE_GOLDEN_SET,
      declines,
    );

    expect(report.declined).toHaveLength(PRODUCT_TYPE_GOLDEN_SET.length);
    expect(report.failures.every((failure) => failure.actual === null)).toBe(
      true,
    );
  });

  it("fails a class that is wholly wrong even when the average looks fine", () => {
    // Wine outnumbers sake here, so a classifier that gets every wine right and
    // every sake wrong still scores well. "Every sake is mislabelled" is not a
    // rounding error to the merchant selling sake.
    const sakeIsAlwaysOther = (excerpt: string): ProductType => {
      const actual = perfect(excerpt);
      return actual === "sake" ? "other" : actual;
    };

    const report = evaluateProductTypeClassification(
      PRODUCT_TYPE_GOLDEN_SET,
      sakeIsAlwaysOther,
      { minimumAccuracy: 0.8, perfectClasses: ["sake"] },
    );

    expect(report.accuracy).toBeGreaterThan(0.8);
    expect(report.passed).toBe(false);
    expect(report.byExpected.sake).toEqual({ correct: 0, total: 2 });
  });

  it("accepts a threshold below perfect when the class floors are met", () => {
    const oneWineWrong = (excerpt: string): ProductType =>
      excerpt.startsWith("Champagne") ? "other" : perfect(excerpt);

    const report = evaluateProductTypeClassification(
      PRODUCT_TYPE_GOLDEN_SET,
      oneWineWrong,
      { minimumAccuracy: 0.9, perfectClasses: ["sake", "spirits"] },
    );

    expect(report.passed).toBe(true);
    expect(report.correct).toBe(PRODUCT_TYPE_GOLDEN_SET.length - 1);
  });

  it("counts each expected class against its own total", () => {
    const cases: ProductTypeCase[] = [
      { id: "a", excerpt: "x", expected: "wine", probes: "synthetic" },
      { id: "b", excerpt: "y", expected: "sake", probes: "synthetic" },
    ];

    const report = evaluateProductTypeClassification(cases, () => "wine");

    expect(report.byExpected.wine).toEqual({ correct: 1, total: 1 });
    expect(report.byExpected.sake).toEqual({ correct: 0, total: 1 });
    expect(report.byExpected.other).toEqual({ correct: 0, total: 0 });
  });
});
