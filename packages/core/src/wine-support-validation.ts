import {
  requireWineValue,
  wineNumericValueSupported,
} from "./wine-artifact-validation-helpers.js";
import type {
  WineFrozenContext,
  WineSupportProposal,
} from "./wine-artifact-schemas.js";
/** Mechanical proposal checks only: containment/value normalization is NOT semantic field association.
 * Task 8 may independently approve a labelled field parser match; unconstrained associations
 * must stay proposals/unknown or require review, never be copied into trusted supports. */
export function validateWineSupportProposal(
  proposal: WineSupportProposal,
  sources: WineFrozenContext["sources"],
): void {
  const matches = sources.filter((s) => s.id === proposal.sourceId);
  requireWineValue(matches.length === 1, "Unknown support source");
  const source = matches[0]!;
  requireWineValue(
    source.excerpt.includes(proposal.span),
    "Unknown support span",
  );
  const fold = (v: string) =>
    v.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
  const values = Array.isArray(proposal.value)
    ? proposal.value
    : [proposal.value];
  for (const value of values)
    requireWineValue(
      typeof value === "number"
        ? wineNumericValueSupported(proposal.field, proposal.span, value)
        : !!fold(value) && fold(proposal.span).includes(fold(value)),
      "Unsupported span value",
    );
}
