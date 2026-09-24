import type { ListingFacts } from "@wukong/core";

/**
 * Measuring the one fact grounding stopped policing.
 *
 * `FACT_GROUNDING_MODES` marks `productType` as `classified`: no label prints
 * the word "wine", so requiring the value to appear in its own excerpt rejected
 * every correct extraction. The check became "cite the text you judged from",
 * which is honest about what it can verify and deliberately says nothing about
 * whether the judgement was right.
 *
 * That traded a broken check for an unmeasured one, and the decision log says
 * so (D1: "classification accuracy is now an eval concern"). This is the
 * measurement. It scores any classifier against labelled cases and reports what
 * it got wrong, so the question has an answer instead of an assumption.
 *
 * It does NOT establish the deployed model's accuracy. Nothing here calls a
 * provider; running this against a real model needs a credential and a paid
 * call, and that remains outstanding.
 */
export type ProductType = NonNullable<ListingFacts["productType"]>;

export const PRODUCT_TYPES: readonly ProductType[] = [
  "wine",
  "spirits",
  "sake",
  "other",
];

export type ProductTypeCase = {
  id: string;
  /**
   * Label wording, synthetic throughout. Modelled on how these categories are
   * actually printed -- no customer document appears in this repository.
   */
  excerpt: string;
  expected: ProductType;
  /** What this case is for. A case that probes nothing is noise. */
  probes: string;
};

/**
 * The cases worth being right about.
 *
 * Chosen for the traps, not for coverage theatre: the easy ones are here to
 * catch a classifier that has stopped working at all, and the rest are the
 * places a plausible reading goes wrong.
 *
 * Two classification policies are asserted here rather than assumed, because
 * the four-value enum forces a choice and the choice should be reviewable:
 *
 * - Fortified and aromatised wine (Port, Sherry, Vermouth) is `wine`. It is
 *   made from grapes and sold beside wine, and calling it `spirits` because it
 *   has been fortified would put Port next to gin.
 * - A fruit liqueur (umeshu) is `other`. It is neither grape wine nor a
 *   distilled spirit, and `sake` is wrong despite the Japanese origin -- a trap
 *   worth having, because the shelf next to it is full of sake.
 */
export const PRODUCT_TYPE_GOLDEN_SET: readonly ProductTypeCase[] = [
  {
    id: "wine-bordeaux-appellation",
    excerpt: "Appellation Margaux Contrôlée · Grand Vin de Bordeaux · 2016",
    expected: "wine",
    probes: "an appellation, with no category word printed anywhere",
  },
  {
    id: "wine-mosel-riesling",
    excerpt: "Mosel · Riesling Kabinett · Prädikatswein · 9,5 % vol",
    expected: "wine",
    probes: "a German quality tier instead of a category word",
  },
  {
    id: "wine-champagne",
    excerpt: "Champagne · Brut Réserve · Élaboré en France",
    expected: "wine",
    probes: "sparkling wine named only by its region",
  },
  {
    id: "wine-port-fortified",
    excerpt: "Porto · Tawny · 20 Anos · 20 % vol",
    expected: "wine",
    probes:
      "fortified wine at spirit-like strength -- 20 % vol invites 'spirits'",
  },
  {
    id: "wine-sherry-fino",
    excerpt: "Jerez-Xérès-Sherry · Fino · Muy Seco · 15 % vol",
    expected: "wine",
    probes: "fortified wine again, under a name that rarely says 'wine'",
  },
  {
    id: "wine-vermouth",
    excerpt: "Vermouth di Torino · Rosso · Vino aromatizzato · 16 % vol",
    expected: "wine",
    probes: "aromatised wine, commonly shelved with spirits",
  },
  {
    id: "spirits-scotch-single-malt",
    excerpt: "Single Malt Scotch Whisky · Aged 12 Years · 43 % vol",
    expected: "spirits",
    probes: "the straightforward case, so a broken classifier is visible",
  },
  {
    id: "spirits-baijiu-chinese",
    excerpt: "貴州 醬香型 白酒 · 53 % vol · 500 毫升",
    expected: "spirits",
    probes:
      "白酒 is baijiu, a grain spirit. Read character by character it is 'white alcohol', and a translation-first reading lands on 'white wine'",
  },
  {
    id: "spirits-cognac",
    excerpt: "Cognac · V.S.O.P · Eau-de-vie de vin · 40 % vol",
    expected: "spirits",
    probes:
      "distilled FROM wine, and the label says so -- 'de vin' invites 'wine'",
  },
  {
    id: "spirits-gin",
    excerpt: "London Dry Gin · Distilled with juniper · 47 % vol",
    expected: "spirits",
    probes: "a category word that is not one of the four enum values",
  },
  {
    id: "sake-junmai-daiginjo",
    excerpt: "純米大吟醸 · 精米歩合 45% · 日本酒度 +3 · 15 度",
    expected: "sake",
    probes: "a sake label with no Latin script at all",
  },
  {
    id: "sake-tokubetsu-honjozo",
    excerpt: "特別本醸造 · 清酒 · 720ml · アルコール分 15 度",
    expected: "sake",
    probes: "清酒 is the legal term for sake; 醸造 can read as generic brewing",
  },
  {
    id: "other-umeshu",
    excerpt: "梅酒 · Plum Liqueur · 12 % vol · Japan",
    expected: "other",
    probes:
      "Japanese and 酒, but a fruit liqueur -- neither sake nor grape wine nor a distilled spirit",
  },
  {
    id: "other-non-alcoholic",
    excerpt: "Alcohol-free sparkling · De-alcoholised · 0,0 % vol",
    expected: "other",
    probes: "reads like sparkling wine and is not an alcoholic product at all",
  },
];

export type ClassificationEvaluation = {
  passed: boolean;
  accuracy: number;
  correct: number;
  total: number;
  /** Per expected class, so a classifier that only ever answers "wine" shows. */
  byExpected: Record<ProductType, { correct: number; total: number }>;
  failures: Array<{
    id: string;
    excerpt: string;
    expected: ProductType;
    actual: ProductType | null;
    probes: string;
  }>;
  /** Cases the classifier declined. Counted apart from getting it wrong. */
  declined: string[];
};

export type ProductTypeClassifier = (
  excerpt: string,
) => ProductType | null | undefined;

export type ClassificationThresholds = {
  /** Fraction of cases that must be correct, 0..1. */
  minimumAccuracy: number;
  /**
   * Classes that must be perfect.
   *
   * Accuracy alone hides a class: getting every wine right and every sake wrong
   * still scores well when wine outnumbers sake, and "every sake is mislabelled"
   * is not a rounding error to the merchant selling it.
   */
  perfectClasses?: readonly ProductType[];
};

/** Scores a classifier against labelled cases. Pure; calls no provider. */
export function evaluateProductTypeClassification(
  cases: readonly ProductTypeCase[],
  classify: ProductTypeClassifier,
  thresholds: ClassificationThresholds = { minimumAccuracy: 1 },
): ClassificationEvaluation {
  const byExpected = Object.fromEntries(
    PRODUCT_TYPES.map((type) => [type, { correct: 0, total: 0 }]),
  ) as ClassificationEvaluation["byExpected"];
  const failures: ClassificationEvaluation["failures"] = [];
  const declined: string[] = [];

  for (const testCase of cases) {
    byExpected[testCase.expected].total += 1;
    const actual = classify(testCase.excerpt) ?? null;
    if (actual === testCase.expected) {
      byExpected[testCase.expected].correct += 1;
      continue;
    }
    if (actual === null) declined.push(testCase.id);
    failures.push({
      id: testCase.id,
      excerpt: testCase.excerpt,
      expected: testCase.expected,
      actual,
      probes: testCase.probes,
    });
  }

  const total = cases.length;
  const correct = total - failures.length;
  // An empty set scores 0, never 1: "nothing to check" must not read as a pass.
  const accuracy = total === 0 ? 0 : correct / total;
  const perfectClassMissed = (thresholds.perfectClasses ?? []).some(
    (type) => byExpected[type].correct !== byExpected[type].total,
  );

  return {
    passed:
      total > 0 &&
      accuracy >= thresholds.minimumAccuracy &&
      !perfectClassMissed,
    accuracy,
    correct,
    total,
    byExpected,
    failures,
    declined,
  };
}

/** Mirrors `assertEvaluation`: throws with the cases that failed, not a count. */
export function assertClassificationEvaluation(
  report: ClassificationEvaluation,
): void {
  if (report.passed) return;
  const detail = report.failures
    .map(
      (failure) =>
        `${failure.id}: expected ${failure.expected}, got ${failure.actual ?? "nothing"} (${failure.probes})`,
    )
    .join("; ");
  throw new Error(
    `product type classification failed at ${report.correct}/${report.total}: ${detail || "no cases were scored"}`,
  );
}
