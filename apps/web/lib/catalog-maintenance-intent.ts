export type MaintenanceIntent =
  "maintain-existing" | "reference-only" | "new-draft";

export function maintenanceDestination(intent: MaintenanceIntent): string {
  return intent === "new-draft"
    ? "/listings/new"
    : `/listings/import?intent=${intent}`;
}

type IdentityRow = Readonly<Record<string, string | null | undefined>>;
export type MaintenanceMatch = {
  state: "matched" | "confirmation_required" | "blocked";
  reasons: string[];
};
export type MaintenanceReferenceRequest = {
  referenceKind: "workbook" | "website";
  referenceId: string;
  remoteProductId: string;
  expectedConnectionId: string;
  identityConfirmed: boolean;
  storeSourceConfirmed: boolean;
};

function observed<T>(values: T[], invalid: boolean) {
  const observed = [...new Set(values)];
  return invalid || observed.length > 1
    ? { state: "ambiguous" as const, value: null }
    : observed.length === 1
      ? { state: "known" as const, value: observed[0]! }
      : { state: "missing" as const, value: null };
}

// Names supply observed facts only. They never establish a remote binding.
// In particular, an absent pack size is unknown, not a one-bottle default.
function observedFacts(row: IdentityRow) {
  const text = `${row.nameEn ?? ""} ${row.nameZh ?? ""}`;
  const years = [...text.matchAll(/\b(?:19|20)\d{2}\b/g)].map((m) => m[0]);
  if (/\b(?:nv|non[ -]?vintage)\b|\u7121\u5e74\u4efd/i.test(text))
    years.push("NV");
  const volumes = [
    ...text.matchAll(/\b(\d+(?:\.\d+)?)\s*(ml|cl|litres?|liters?|l)\b/gi),
  ].map(
    (m) =>
      Number(m[1]) *
      (/^ml$/i.test(m[2]!) ? 1 : /^cl$/i.test(m[2]!) ? 10 : 1000),
  );
  const packs = [
    ...[
      ...text.matchAll(
        /\b(\d+)\s*(?:bottles?|packs?)\b|(?:\bcase\s+of\s+)(\d+)\b|(\d+)\s*\u652f\u88dd/gi,
      ),
    ].map((m) => Number(m[1] ?? m[2] ?? m[3])),
    ...[
      ...text.matchAll(/\b(\d+)\s*(?:x|×)\s*\d+(?:\.\d+)?\s*(?:ml|cl|l)\b/gi),
    ].map((m) => Number(m[1])),
    ...[...text.matchAll(/\b(\d+)[ -]pack\b/gi)].map((m) => Number(m[1])),
  ];
  const invalid = { year: false, volume: false, pack: false };
  // Structured observations are evidence too. Keep every recognized alias so
  // two contradictory attributes cannot become a confirmable missing fact.
  for (const [key, value] of Object.entries(row)) {
    if (!value?.trim()) continue;
    const name = key.toLowerCase().replace(/[ _-]/g, "");
    const text = value.trim();
    if (["vintage", "year"].includes(name)) {
      if (/^(?:nv|non[ -_]?vintage)$/i.test(text)) years.push("NV");
      else if (/^(?:19|20)\d{2}$/.test(text)) years.push(text);
      else invalid.year = true;
    } else if (["volumeml", "volume", "size"].includes(name)) {
      const volume = /^(\d+(?:\.\d+)?)\s*(ml|cl|litres?|liters?|l)?$/i.exec(
        text,
      );
      if (!volume || Number(volume[1]) <= 0) invalid.volume = true;
      else
        volumes.push(
          Number(volume[1]) *
            (!volume[2] || /^ml$/i.test(volume[2])
              ? 1
              : /^cl$/i.test(volume[2])
                ? 10
                : 1000),
        );
    } else if (["packquantity", "packcount"].includes(name)) {
      if (!/^\d+$/.test(text) || Number(text) <= 0) invalid.pack = true;
      else packs.push(Number(text));
    }
  }
  return {
    year: observed(years, invalid.year),
    volume: observed(volumes, invalid.volume),
    pack: observed(packs, invalid.pack),
  };
}

export function observedMaintenancePack(row: IdentityRow): number | null {
  const pack = observedFacts(row).pack;
  return pack.state === "known" &&
    Number.isSafeInteger(pack.value) &&
    Number(pack.value) > 0
    ? Number(pack.value)
    : null;
}

export function matchMaintenanceCandidate(input: {
  connectionId: string;
  expectedConnectionId: string;
  referenceRaw: IdentityRow;
  currentRaw: IdentityRow;
}): MaintenanceMatch {
  const blocked: string[] = [];
  const unknown: string[] = [];
  if (input.connectionId !== input.expectedConnectionId)
    blocked.push("store_mismatch");
  const referenceId = input.referenceRaw.productId?.trim();
  const currentId = input.currentRaw.productId?.trim();
  if (!currentId) blocked.push("product_id_missing");
  if (!referenceId) unknown.push("reference_product_id_unknown");
  else if (referenceId !== currentId) blocked.push("product_id_mismatch");
  if (
    input.referenceRaw.variantId?.trim() ||
    input.currentRaw.variantId?.trim()
  )
    blocked.push("variant_unsupported");
  const reference = observedFacts(input.referenceRaw);
  const current = observedFacts(input.currentRaw);
  for (const fact of ["year", "volume", "pack"] as const) {
    if (
      reference[fact].state === "ambiguous" ||
      current[fact].state === "ambiguous"
    )
      blocked.push(`${fact}_ambiguous`);
    else if (
      reference[fact].state === "missing" ||
      current[fact].state === "missing"
    )
      unknown.push(`${fact}_unknown`);
    else if (reference[fact].value !== current[fact].value)
      blocked.push(`${fact}_mismatch`);
  }
  if (!input.referenceRaw.sku?.trim() || !input.currentRaw.sku?.trim())
    unknown.push("sku_hint_unknown");
  else if (input.referenceRaw.sku !== input.currentRaw.sku)
    unknown.push("sku_hint_changed");
  return blocked.length
    ? { state: "blocked", reasons: blocked }
    : unknown.length
      ? { state: "confirmation_required", reasons: unknown }
      : { state: "matched", reasons: [] };
}
