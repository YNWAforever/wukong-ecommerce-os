import {
  sameWineValue,
  type QualityIssue,
  type WineContent,
} from "@wukong/core";
import type {
  WineGenerationRequest,
  WineGenerationCandidate,
} from "./wine-enrichment-schemas.js";
import {
  requireValue,
  unique,
  references,
  wineNumericValueSupported,
} from "./wine-enrichment-grounding.js";
export function wineTextPaths(c: WineContent): Map<string, string> {
  const paths = new Map<string, string>();
  for (const lang of ["en", "zh-Hant"] as const) {
    paths.set(`title.${lang}`, c.title[lang]);
    paths.set(`seo.title.${lang}`, c.seo.title[lang]);
    paths.set(`seo.description.${lang}`, c.seo.description[lang]);
    for (const s of c.sections) paths.set(`sections.${s.key}.${lang}`, s[lang]);
  }
  c.tags.forEach((tag, i) => paths.set(`tags.${i}`, tag));
  return paths;
}
function locked(path: string, r: WineGenerationRequest) {
  return r.lockedPaths.some((p) => path === p || path.startsWith(p + "."));
}
export function validateWineGenerationRequest(r: WineGenerationRequest): void {
  unique(
    r.claims.map((c) => c.id),
    "claims",
  );
  if (r.section)
    requireValue(r.current, "Section generation requires current content");
  const facts = new Set(
    r.claims
      .filter((c) => c.kind === "fact" && c.scope === "product")
      .map((c) => c.id),
  );
  for (const c of r.claims) {
    requireValue(c.state === "accepted", "Writing requires accepted claims");
    unique(c.evidenceIds, "evidence references");
    if (c.kind === "recommendation") {
      requireValue(
        c.scope === "product" && ["pairing", "serving"].includes(c.field),
        "Invalid recommendation",
      );
      references(c.premiseClaimIds, facts);
      const evidence = new Set(
        r.claims
          .filter((p) => c.premiseClaimIds.includes(p.id))
          .flatMap((p) => p.evidenceIds),
      );
      references(c.evidenceIds, evidence);
    }
  }
  if (r.current)
    unique(
      r.current.sections.map((s) => s.key),
      "current sections",
    );
  const allowed = new Set([
    "title",
    "seo",
    "seo.title",
    "seo.description",
    "tags",
    "sections",
    ...wineTextPaths(
      r.current ?? {
        title: { en: "", "zh-Hant": "" },
        seo: {
          title: { en: "", "zh-Hant": "" },
          description: { en: "", "zh-Hant": "" },
        },
        tags: [],
        sections: [],
      },
    ).keys(),
    ...[
      "selling_points",
      "introduction",
      "tasting",
      "pairing",
      "serving",
      "brand_background",
    ].flatMap((k) => [
      `sections.${k}`,
      `sections.${k}.en`,
      `sections.${k}.zh-Hant`,
    ]),
  ]);
  for (const p of r.lockedPaths)
    requireValue(allowed.has(p), "Unknown locked content path");
  requireValue(
    r.current || r.lockedPaths.length === 0,
    "Locks require current content",
  );
}
/** Mechanical failures remain blocking even if semantic review reports no issues. */
export function wineCandidateIssues(
  r: WineGenerationRequest,
  c: WineGenerationCandidate,
): QualityIssue[] {
  const issues: QualityIssue[] = [];
  const issue = (path: string, code: string) =>
    issues.push({ path, code, blocking: true, evidenceIds: [] });
  const paths = wineTextPaths(c.content),
    old = r.current ? wineTextPaths(r.current) : new Map<string, string>();
  if (
    new Set(c.content.sections.map((s) => s.key)).size !==
    c.content.sections.length
  )
    issue("sections", "duplicate_section");
  for (const [path, text] of old) {
    if (
      (locked(path, r) ||
        (r.section && !path.startsWith(`sections.${r.section}.`))) &&
      paths.get(path) !== text
    )
      issue(path, "protected_content_changed");
  }
  // A lock also protects absence: introducing any leaf below it changes the snapshot.
  for (const path of paths.keys()) {
    if (locked(path, r) && !old.has(path))
      issue(path, "protected_content_introduced");
  }
  if (r.current) {
    if (
      locked("sections", r) &&
      JSON.stringify(c.content.sections) !== JSON.stringify(r.current.sections)
    )
      issue("sections", "protected_content_changed");
    if (
      r.section &&
      JSON.stringify(
        c.content.sections.filter((s) => s.key !== r.section).map((s) => s.key),
      ) !==
        JSON.stringify(
          r.current.sections
            .filter((s) => s.key !== r.section)
            .map((s) => s.key),
        )
    )
      issue("sections", "section_order_changed");
    for (const s of r.current.sections) {
      const next = c.content.sections.find((n) => n.key === s.key);
      if (
        s.locked ||
        s.owner === "operator" ||
        locked(`sections.${s.key}`, r) ||
        (r.section && s.key !== r.section)
      ) {
        if (JSON.stringify(next) !== JSON.stringify(s))
          issue(`sections.${s.key}`, "protected_section_changed");
      } else if (next && (next.locked !== s.locked || next.owner !== s.owner))
        issue(`sections.${s.key}`, "ownership_changed");
    }
    if (r.section || locked("tags", r)) {
      if (JSON.stringify(c.content.tags) !== JSON.stringify(r.current.tags))
        issue("tags", "protected_content_changed");
    }
  }
  for (const s of c.content.sections) {
    const previous = r.current?.sections.find((o) => o.key === s.key);
    if (
      JSON.stringify(previous) !== JSON.stringify(s) &&
      !!s.en.trim() !== !!s["zh-Hant"].trim()
    )
      issue(`sections.${s.key}`, "missing_translation");
    if (
      !r.current?.sections.some((o) => o.key === s.key) &&
      (s.locked || s.owner !== "automatic")
    )
      issue(`sections.${s.key}`, "ownership_changed");
    if (
      r.section &&
      s.key !== r.section &&
      !r.current?.sections.some((o) => o.key === s.key)
    )
      issue(`sections.${s.key}`, "section_scope");
    const ids = c.annotations
      .filter((a) => a.path.startsWith(`sections.${s.key}.`))
      .map((a) => a.claimId);
    if (
      new Set(s.claimIds).size !== s.claimIds.length ||
      (JSON.stringify(previous) !== JSON.stringify(s) &&
        s.claimIds.some((id) => !r.claims.some((cl) => cl.id === id))) ||
      ids.some((id) => !s.claimIds.includes(id))
    )
      issue(`sections.${s.key}`, "claim_references");
  }
  for (const a of c.annotations) {
    const cl = r.claims.find((x) => x.id === a.claimId),
      text = paths.get(a.path);
    if (!cl || text === undefined || !text.includes(a.span)) {
      issue(a.path, "invalid_annotation");
      continue;
    }
    if (
      !sameWineValue(a.value, cl.value) ||
      JSON.stringify([...a.evidenceIds].sort()) !==
        JSON.stringify([...cl.evidenceIds].sort()) ||
      JSON.stringify([...a.premiseClaimIds].sort()) !==
        JSON.stringify([...cl.premiseClaimIds].sort())
    )
      issue(a.path, "claim_binding");
    if (
      cl.scope === "brand" &&
      !a.path.startsWith("sections.brand_background.")
    )
      issue(a.path, "brand_scope");
    if (
      cl.kind === "recommendation" &&
      (!a.path.startsWith(`sections.${cl.field}.`) ||
        !/recommend|suggest|建議|推薦/i.test(a.span))
    )
      issue(a.path, "recommendation_label_or_scope");
    // Every numeric token must independently match the bound value and its explicit unit.
    if (
      /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b(?:[\s-]+\w+){0,3}[\s-]+(?:years?|percent|litres?|liters?|millilitres?|milliliters?|bottles?|points?)\b|[零〇一二兩三四五六七八九十百千萬]+(?:年|毫升|升|度|瓶|分)/iu.test(
        a.span,
      )
    )
      issue(a.path, "unsupported_numeric_format");
    const nums = outputNumericTokens(a.span);
    for (const token of nums) {
      const ok =
        typeof cl.value === "number"
          ? numericOutputSupported(cl.field, token, cl.value)
          : (Array.isArray(cl.value) ? cl.value : [cl.value])
              .flatMap(outputNumericTokens)
              .includes(token);
      if (!ok) issue(a.path, "unsupported_number_or_unit");
    }
    if (
      typeof cl.value === "number" &&
      (!nums.length || !wineNumericValueSupported(cl.field, a.span, cl.value))
    )
      issue(a.path, "missing_numeric_value");
  }
  for (const [path, text] of paths) {
    if (!text.trim() || old.get(path) === text) continue;
    const coverage = new Array(text.length).fill(false);
    for (const a of c.annotations.filter((a) => a.path === path)) {
      let start = text.indexOf(a.span);
      while (start >= 0) {
        for (let i = start; i < start + a.span.length; i++) coverage[i] = true;
        start = text.indexOf(a.span, start + a.span.length);
      }
    }
    if (
      [...text].some(
        (ch, i) => !coverage[i] && !/\s|[.,;:!?。；，：！？、]/u.test(ch),
      )
    )
      issue(path, "unannotated_output");
    if (/[<>$€£¥]|\b(?:price|stock|sku)\b|售價|庫存|https?:\/\//i.test(text))
      issue(path, "unsupported_format");
    if (r.section && !path.startsWith(`sections.${r.section}.`))
      issue(path, "section_scope");
  }
  return issues;
}

function numericOutputSupported(
  field: string,
  token: string,
  value: number,
): boolean {
  if (!wineNumericValueSupported(field, token, value)) return false;

  let unit = token
    .replace(/^[+\-\d.,\s/⁄]+/, "")
    .trim()
    .toLowerCase();
  // This exact bottle-format phrase is prose, not a second measurement unit.
  // Do not strip arbitrary Han suffixes: 公斤, 盎司 and concatenated units must fail.
  if (field === "volumeMl")
    unit = unit.replace(/^(毫升|厘升|公升|升)瓶裝$/u, "$1");
  const allowed: Record<string, string[]> = {
    volumeMl: [
      "",
      "ml",
      "cl",
      "dl",
      "l",
      "millilitre",
      "millilitres",
      "milliliter",
      "milliliters",
      "centilitre",
      "centilitres",
      "centiliter",
      "centiliters",
      "decilitre",
      "decilitres",
      "deciliter",
      "deciliters",
      "litre",
      "litres",
      "liter",
      "liters",
      "毫升",
      "厘升",
      "公升",
      "升",
    ],
    abvPercent: ["%", "percent", "度"],
    polishingPercent: ["%", "percent"],
    ageYears: ["years", "year", "年"],
    vintage: ["", "年"],
    brewingYear: ["", "年"],
    packQuantity: ["", "bottles", "bottle", "瓶"],
  };
  return (allowed[field] ?? []).includes(unit);
}

/** Retain the entire adjacent letter/unit run, including unknown Chinese units.
 * String claims compare complete normalized tokens, never substrings of serialized JSON. */
function outputNumericTokens(text: string): string[] {
  return [
    ...text
      .normalize("NFKC")
      .matchAll(
        /[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)(?:\s*[/⁄]\s*\d+(?:[.,]\d+)?)?\s*[\p{L}%°]*/gu,
      ),
  ].map((m) => m[0].trim().replace(/\s+/g, " ").toLowerCase());
}
