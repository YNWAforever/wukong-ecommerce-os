import {
  validateWineSupportProposal,
  wineFrozenContextSchema,
  wineSupportProposalSchema,
  type WineFrozenContext,
  type WineSupportProposal,
} from "@wukong/ai";
import {
  evidenceSourceSchema,
  matchWineIdentity,
  productIdentitySchema,
  resolveWineSourceAuthority,
  resolveWineSourceReliability,
  sameWineValue,
  wineSourceAuthoritySchema,
  type EvidenceSource,
  type ProductIdentity,
  type QualityIssue,
  type WineSourceAuthority,
  type FieldObservation,
} from "@wukong/core";

type Binding = WineFrozenContext["binding"];
/** Internal server checkpoint envelope, NEVER a provider response schema.
 * Web provenance must come from acquisition; photos from extraction + accepted assets.
 * Cache consumers must validate lineage/policy/expiry before establishing this run binding. */
export type WineRetainedSource = {
  binding: Binding;
  assetDigest: string | null;
  documentDigest: string;
  source: EvidenceSource;
};
export type WineGroundingInput = {
  accepted: {
    binding: Binding;
    assets: { id: string; digest: string }[];
    note: string | null;
    lockedFields: string[];
    verifiedAliases: WineFrozenContext["verifiedAliases"];
  };
  extraction: { binding: Binding; identity: ProductIdentity };
  records: WineRetainedSource[];
  authorities: WineSourceAuthority[];
  proposals?: unknown[];
  now: string;
};
export type WineGroundingResult = {
  context: WineFrozenContext;
  issues: QualityIssue[];
};
const labels: Record<string, string[]> = {
  kind: ["kind", "種類"],
  producer: ["producer", "生產商", "酒莊"],
  productName: ["product", "product name", "產品名稱", "酒款"],
  cuvee: ["cuvee", "cuvée", "特釀"],
  vintage: ["vintage", "年份"],
  volumeMl: ["volume", "容量"],
  packQuantity: ["pack quantity", "每包數量"],
  marketVariant: ["market", "市場"],
  barcode: ["barcode", "條碼"],
  abvPercent: ["abv", "alcohol", "酒精濃度"],
  appellation: ["appellation", "法定產區"],
  grapeVarieties: ["grape varieties", "葡萄品種"],
  fermentation: ["fermentation", "發酵"],
  maturation: ["maturation", "熟成"],
  spiritType: ["spirit type", "烈酒種類"],
  ageYears: ["age", "酒齡"],
  caskType: ["cask type", "酒桶種類"],
  batch: ["batch", "批次"],
  brewery: ["brewery", "酒藏"],
  grade: ["grade", "等級"],
  riceVariety: ["rice variety", "米種"],
  polishingPercent: ["polishing ratio", "精米步合"],
  brewingYear: ["brewing year", "釀造年份"],
};
const categories = {
  wine: ["appellation", "grapeVarieties", "fermentation", "maturation"],
  spirits: ["spiritType", "ageYears", "caskType", "batch"],
  sake: ["brewery", "grade", "riceVariety", "polishingPercent", "brewingYear"],
};
const numeric = new Set([
  "vintage",
  "volumeMl",
  "packQuantity",
  "abvPercent",
  "ageYears",
  "polishingPercent",
  "brewingYear",
]);
const scalarFields = [
  "producer",
  "productName",
  "cuvee",
  "volumeMl",
  "packQuantity",
  "marketVariant",
  "barcode",
  "abvPercent",
] as const;
const fold = (s: string) => s.normalize("NFKC").trim().toLowerCase();
function assert(ok: unknown, code: string): asserts ok {
  if (!ok) throw new Error(code);
}
function sameBinding(a: Binding, b: Binding) {
  return (
    a.workspaceId === b.workspaceId &&
    a.operationId === b.operationId &&
    a.inputRevision === b.inputRevision
  );
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function mechanical(proposal: WineSupportProposal, source: EvidenceSource) {
  try {
    validateWineSupportProposal(proposal, [source]);
    return true;
  } catch {
    return false;
  }
}
function numberValue(
  field: string,
  text: string,
  span: string,
  source: EvidenceSource,
): number | null {
  // Whole value grammar rules out footer numbers, ranges, wrong units and trailing prose.
  const units: Record<string, string> = {
    volumeMl:
      "(?:ml|cl|dl|l|millilitres?|milliliters?|centilitres?|centiliters?|decilitres?|deciliters?|litres?|liters?|毫升|厘升|公升|升)",
    abvPercent: "%",
    polishingPercent: "%",
    ageYears: "(?:years?|年)",
    packQuantity: "(?:bottles?|瓶)?",
    vintage: "年?",
    brewingYear: "年?",
  };
  const value = text.normalize("NFKC");
  const m = value.match(
    new RegExp(
      `^(\\d+(?:[.,]\\d+)?(?:\\s*[/⁄]\\s*\\d+(?:[.,]\\d+)?)?)\\s*${units[field]}$`,
      "i",
    ),
  );
  if (!m) return null;
  const parts = m[1]!
    .split(/[/⁄]/)
    .map((n) => Number(n.trim().replace(",", ".")));
  const amount = parts.length === 2 ? parts[0]! / parts[1]! : parts[0]!;
  const candidates =
    field === "volumeMl"
      ? [amount, amount * 10, amount * 100, amount * 1000]
      : [amount];
  return (
    candidates.find(
      (value) =>
        Number.isFinite(value) &&
        mechanical(
          {
            sourceId: source.id,
            field: field as WineSupportProposal["field"],
            value,
            span,
          },
          source,
        ),
    ) ?? null
  );
}
function parseSource(
  source: EvidenceSource,
  issues: QualityIssue[],
  observedKind?: ProductIdentity["kind"],
) {
  const supports: WineSupportProposal[] = [];
  let kind: ProductIdentity["kind"] | null = null;
  let kindConflict = false;
  for (const line of source.excerpt.split(/\r?\n/)) {
    const m = line.match(/^\s*([^:：]+)[:：]\s*([^\r\n]+?)\s*$/);
    if (!m) continue;
    const field = Object.keys(labels).find((key) =>
      labels[key]!.includes(fold(m[1]!)),
    );
    if (!field) continue;
    const raw = m[2]!.trim();
    if (field === "kind") {
      const k: Record<string, ProductIdentity["kind"]> = {
        wine: "wine",
        spirits: "spirits",
        sake: "sake",
        葡萄酒: "wine",
        烈酒: "spirits",
        清酒: "sake",
      };
      const next = k[fold(raw)];
      if (next) {
        if (kind && kind !== next) kindConflict = true;
        else kind = next;
      }
      continue;
    }
    const value = numeric.has(field)
      ? numberValue(field, raw, line, source)
      : field === "grapeVarieties"
        ? raw.split(/[,、]/).map((x) => x.trim())
        : raw;
    if (value === null || /[<>\u0000-\u001f]/u.test(raw)) {
      issues.push({
        path: `sources.${source.id}.${field}`,
        code: "unsupported_label_value",
        blocking: false,
        evidenceIds: [source.id],
      });
      continue;
    }
    const proposal = wineSupportProposalSchema.safeParse({
      sourceId: source.id,
      field,
      value,
      span: line,
    });
    if (proposal.success && mechanical(proposal.data, source))
      supports.push(proposal.data);
  }
  const scopeKind = kind ?? observedKind;
  const scoped = supports.filter(
    (s) =>
      !scopeKind ||
      !Object.values(categories).flat().includes(s.field) ||
      categories[scopeKind].includes(s.field),
  );
  for (const rejected of supports.filter((s) => !scoped.includes(s)))
    issues.push({
      path: `sources.${source.id}.${rejected.field}`,
      code: "category_not_applicable",
      blocking: false,
      evidenceIds: [source.id],
    });
  return { supports: scoped, kind: kindConflict ? null : kind };
}
function emptyIdentity(kind: ProductIdentity["kind"]): ProductIdentity {
  return {
    schemaVersion: 1,
    kind,
    producer: null,
    productName: null,
    aliases: [],
    cuvee: null,
    vintage: { state: "unknown", year: null },
    volumeMl: null,
    packQuantity: null,
    marketVariant: null,
    barcode: null,
    abvPercent: null,
    category: {},
    observations: {},
    status: "candidate",
  };
}
function sourceIdentity(
  source: EvidenceSource,
  kind: ProductIdentity["kind"] | null,
  supports: WineSupportProposal[],
): ProductIdentity | null {
  if (!kind) return null;
  const out = emptyIdentity(kind);
  for (const field of [...scalarFields, "vintage", ...categories[kind]]) {
    const entries = supports.filter((s) => s.field === field);
    if (!entries.length) continue;
    const first = entries[0]!;
    const observation: FieldObservation = {
      value: first.value,
      state: entries.some((s) => !sameWineValue(s.value, first.value))
        ? "conflict"
        : "normalized",
      evidenceIds: [source.id],
    };
    if (categories[kind].includes(field))
      (out.category as Record<string, FieldObservation>)[field] = observation;
    else {
      (out.observations as Record<string, FieldObservation>)[field] =
        observation;
      if (field === "vintage")
        out.vintage = { state: "known", year: first.value as number };
      else Object.assign(out, { [field]: first.value });
    }
  }
  const parsed = productIdentitySchema.safeParse(out);
  return parsed.success ? parsed.data : null;
}
function clearObservation(identity: ProductIdentity, field: string) {
  delete (identity.observations as Record<string, FieldObservation>)[field];
  delete (identity.category as Record<string, FieldObservation>)[field];
  if (field === "vintage") identity.vintage = { state: "unknown", year: null };
  else if (field === "aliases") identity.aliases = [];
  else if (scalarFields.includes(field as (typeof scalarFields)[number]))
    Object.assign(identity, { [field]: null });
}
/** Pure boundary: no provider calls and no source authority inferred from ranking/model tags. */
export function groundWineEvidence(
  raw: WineGroundingInput,
): WineGroundingResult {
  const input = structuredClone(raw),
    { accepted } = input;
  const binding = wineFrozenContextSchema.shape.binding.parse(accepted.binding);
  assert(
    sameBinding(binding, input.extraction.binding),
    "extraction_binding_invalid",
  );
  assert(
    new Set(accepted.assets.map((a) => a.id)).size === accepted.assets.length,
    "duplicate_asset",
  );
  const identity = productIdentitySchema.parse(input.extraction.identity);
  const authorities = input.authorities.map((a) =>
    wineSourceAuthoritySchema.parse(a),
  );
  const issues: QualityIssue[] = [];
  const sources: EvidenceSource[] = input.records.map((record) => {
    assert(sameBinding(binding, record.binding), "source_binding_invalid");
    const source = evidenceSourceSchema.parse(record.source);
    assert(
      record.documentDigest === source.documentDigest,
      "source_digest_invalid",
    );
    assert(
      source.excerpt.length <= 16000 && source.excerpt.trim(),
      "retained_excerpt_invalid",
    );
    if (source.kind === "photo") {
      assert(
        source.contentScope === "label" &&
          accepted.assets.some(
            (a) =>
              a.id === source.assetId &&
              a.digest === record.assetDigest &&
              !!a.digest,
          ),
        "photo_asset_binding_invalid",
      );
    } else if (source.kind === "merchant")
      assert(
        record.assetDigest === null &&
          source.contentScope === "note" &&
          accepted.note?.includes(source.excerpt),
        "merchant_excerpt_binding_invalid",
      );
    else assert(record.assetDigest === null, "web_asset_binding_invalid");
    return {
      ...source,
      trust: "unverified" as const,
      identity: null as ProductIdentity | null,
    };
  });
  assert(
    new Set(sources.map((s) => s.id)).size === sources.length,
    "duplicate_source",
  );
  const supports: WineSupportProposal[] = [];
  const parsed = new Map(
    sources.map((source) => [
      source.id,
      parseSource(
        source,
        issues,
        source.kind === "web" ? undefined : identity.kind,
      ),
    ]),
  );
  let invalidObservation = identity.status === "needs_confirmation";
  const trustedObservationIds = new Set<string>();
  // OCR observations are bound to the accepted image, not independently certified facts.
  // Printed field prefixes are not required on a physical label.
  for (const [field, obs] of Object.entries({
    ...identity.observations,
    ...identity.category,
  })) {
    if (!obs || obs.value === null) continue;
    const bound: WineSupportProposal[] = [];
    const valid =
      obs.evidenceIds.length > 0 &&
      obs.evidenceIds.every((id) => {
        const source = sources.find((s) => s.id === id);
        if (!source || source.kind === "web" || source.truncated) return false;
        const support = wineSupportProposalSchema.safeParse({
          sourceId: id,
          field,
          value: obs.value,
          span: source.excerpt,
        });
        if (!support.success || !mechanical(support.data, source)) return false;
        bound.push(support.data);
        return true;
      });
    if (valid && obs.state !== "conflict") {
      supports.push(...bound);
      bound.forEach((s) => trustedObservationIds.add(s.sourceId));
    }
    if (!valid || obs.state === "conflict") {
      invalidObservation = true;
      clearObservation(identity, field);
      issues.push({
        path: `identity.${field}`,
        code: "observation_binding_invalid",
        blocking: true,
        evidenceIds: obs.evidenceIds.filter((id) =>
          sources.some((s) => s.id === id),
        ),
      });
    }
  }
  const complete =
    !!identity.producer &&
    !!identity.productName &&
    !!identity.volumeMl &&
    !!identity.packQuantity;
  identity.status =
    invalidObservation || !complete ? "needs_confirmation" : "matched";
  for (const source of sources) {
    const p = parsed.get(source.id)!;
    if (source.kind === "web") {
      source.identity = sourceIdentity(source, p.kind, p.supports);
      const match = source.identity
        ? matchWineIdentity(identity, source.identity, {
            verifiedAliases: accepted.verifiedAliases,
          }).state
        : "ambiguous";
      if (match !== "matched")
        issues.push({
          path: `sources.${source.id}.identity`,
          code:
            match === "mismatch"
              ? "source_identity_mismatch"
              : "source_identity_unresolved",
          blocking: false,
          evidenceIds: [source.id],
        });
      supports.push(...p.supports);
    } else {
      source.identity = structuredClone(identity);
      // Validate fields independently: an invalid optional observation cannot hide
      // another valid contrary fact or fall back to the aggregate identity.
      const proposed = input.records.find((r) => r.source.id === source.id)!
        .source.identity;
      if (proposed) {
        const sanitized = structuredClone(proposed);
        const bound: WineSupportProposal[] = [];
        let conflict = false;
        for (const [field, obs] of Object.entries({
          ...proposed.observations,
          ...proposed.category,
        })) {
          if (!obs || obs.value === null) continue;
          const support = {
            sourceId: source.id,
            field: field as WineSupportProposal["field"],
            value: obs.value,
            span: source.excerpt,
          };
          if (
            !source.truncated &&
            obs.evidenceIds.length > 0 &&
            obs.evidenceIds.every((id) => id === source.id) &&
            mechanical(support, source)
          ) {
            bound.push(support);
            if (obs.state === "conflict") conflict = true;
          } else {
            clearObservation(sanitized, field);
            issues.push({
              path: `sources.${source.id}.identity.${field}`,
              code: "observation_binding_invalid",
              blocking: true,
              evidenceIds: [source.id],
            });
          }
        }
        source.identity = sanitized;
        source.identity.status =
          proposed.status === "needs_confirmation"
            ? "needs_confirmation"
            : "candidate";
        if (proposed.status === "needs_confirmation") {
          identity.status = "needs_confirmation";
          issues.push({
            path: `sources.${source.id}.identity`,
            code: "observation_identity_ambiguous",
            blocking: true,
            evidenceIds: [source.id],
          });
        }
        if (bound.length) {
          supports.push(...bound);
          trustedObservationIds.add(source.id);
        }
        if (
          matchWineIdentity(identity, sanitized, {
            verifiedAliases: accepted.verifiedAliases,
          }).state === "mismatch" ||
          conflict
        ) {
          identity.status = "needs_confirmation";
          issues.push({
            path: `sources.${source.id}.identity`,
            code: "observation_identity_conflict",
            blocking: true,
            evidenceIds: [source.id],
          });
        }
      }
      // Labelled conflicting observations are retained even when not proposed by the model.
      supports.push(...p.supports);
      if (p.kind) {
        const independent = sourceIdentity(source, p.kind, p.supports);
        if (
          independent &&
          matchWineIdentity(identity, independent, {
            verifiedAliases: accepted.verifiedAliases,
          }).state === "mismatch"
        ) {
          identity.status = "needs_confirmation";
          issues.push({
            path: `sources.${source.id}.identity`,
            code: "observation_identity_conflict",
            blocking: true,
            evidenceIds: [source.id],
          });
        }
      }
    }
  }
  const reliableSourceIds: string[] = [];
  for (const source of sources)
    if (
      source.kind === "web" &&
      identity.producer &&
      resolveWineSourceAuthority(
        source,
        { kind: "producer", name: identity.producer },
        authorities,
        input.now,
      )
    )
      source.trust = "verified_official";
    else if (resolveWineSourceReliability(source, authorities, input.now)) {
      source.trust = "reliable";
      reliableSourceIds.push(source.id);
    }
  for (const proposal of input.proposals ?? []) {
    const p = wineSupportProposalSchema.safeParse(proposal);
    if (
      !p.success ||
      p.data.originalAuthority ||
      p.data.applicableVintage ||
      !supports.some(
        (s) =>
          s.sourceId === p.data.sourceId &&
          s.field === p.data.field &&
          s.span === p.data.span &&
          sameWineValue(s.value, p.data.value),
      )
    ) {
      issues.push({
        path: "supportProposals",
        code: "unsupported_proposal",
        blocking: false,
        evidenceIds:
          p.success && sources.some((s) => s.id === p.data.sourceId)
            ? [p.data.sourceId]
            : [],
      });
    }
  }
  const context = wineFrozenContextSchema.parse({
    schemaVersion: 1,
    binding,
    identity,
    sources,
    supports,
    authorities,
    reliableSourceIds,
    trustedObservationSourceIds: [...trustedObservationIds],
    acceptedPremises: [],
    verifiedAliases: accepted.verifiedAliases,
    lockedFields: accepted.lockedFields,
    now: input.now,
  });
  return { context: freeze(context), issues: freeze(issues) };
}
