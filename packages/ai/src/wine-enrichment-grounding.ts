import type { ProductIdentity } from "@wukong/core";
import {
  requireWineValue,
  uniqueWineIds,
  requireWineReferences,
  wineNumericValueSupported,
} from "@wukong/core";
import { withWineProviderOutputError } from "./wine-artifact-validation-errors.js";
export { wineNumericValueSupported } from "@wukong/core";
import type {
  WineFrozenContext,
  WineSupportProposal,
} from "./wine-enrichment-schemas.js";
export function requireValue(ok: unknown, message: string): asserts ok {
  withWineProviderOutputError(() => requireWineValue(ok, message));
}
export function unique(ids: string[], label: string) {
  withWineProviderOutputError(() => uniqueWineIds(ids, label));
}
export function references(ids: string[], allowed: Set<string>) {
  withWineProviderOutputError(() => requireWineReferences(ids, allowed));
}
export function identityReferences(
  identity: ProductIdentity,
  allowed: Set<string>,
) {
  for (const item of [
    ...Object.values(identity.observations),
    ...Object.values(identity.category),
  ])
    if (item) references(item.evidenceIds, allowed);
}
/** Mechanical proposal checks only: containment/value normalization is NOT semantic field association.
 * Task 8 may independently approve a labelled field parser match; unconstrained associations
 * must stay proposals/unknown or require review, never be copied into trusted supports. */
export function validateWineSupportProposal(
  proposal: WineSupportProposal,
  sources: WineFrozenContext["sources"],
): void {
  const matches = sources.filter((s) => s.id === proposal.sourceId);
  requireValue(matches.length === 1, "Unknown support source");
  const source = matches[0]!;
  requireValue(source.excerpt.includes(proposal.span), "Unknown support span");
  const fold = (v: string) =>
    v.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const values = Array.isArray(proposal.value)
    ? proposal.value
    : [proposal.value];
  for (const value of values)
    requireValue(
      typeof value === "number"
        ? wineNumericValueSupported(proposal.field, proposal.span, value)
        : !!fold(value) && fold(proposal.span).includes(fold(value)),
      "Unsupported span value",
    );
}
