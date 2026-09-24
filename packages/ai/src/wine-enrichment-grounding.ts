import { validateWineSupportProposal as validateSharedWineSupportProposal } from "@wukong/core";
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
export function validateWineSupportProposal(
  proposal: WineSupportProposal,
  sources: WineFrozenContext["sources"],
): void {
  withWineProviderOutputError(() =>
    validateSharedWineSupportProposal(proposal, sources),
  );
}
