import type { WorkspaceRole } from "../session-context";
import { requireWorkspaceRole } from "../session-context";

/**
 * Server-derived first-run setup progress (P2).
 *
 * Every step is a fact about durable workspace records, never browser state:
 * a reviewer who clears localStorage still sees the same progress, and a
 * completion cannot be faked by clicking a checklist. A source that could not
 * be read becomes `unknown`, which is excluded from the completed count rather
 * than being treated as zero or done.
 */
export type StudioOnboardingStepKey =
  "store" | "reviewer" | "catalog" | "review" | "signoff" | "export";

export type StudioOnboardingStepState = "done" | "todo" | "unknown";

export type StudioOnboardingOwner = "admin" | "operator" | "reviewer";

export type StudioOnboardingStep = {
  readonly key: StudioOnboardingStepKey;
  readonly state: StudioOnboardingStepState;
  readonly owner: StudioOnboardingOwner;
  /** Present only when this role can act; null means "ask the owner". */
  readonly href: string | null;
};

export type StudioOnboardingFacts = {
  readonly connectionPresent: boolean | null;
  readonly reviewerCount: number | null;
  readonly listingCount: number | null;
  readonly artifactCount: number | null;
  readonly signedOffCount: number | null;
  readonly exportCount: number | null;
};

export type StudioOnboardingResult = {
  /** `unavailable` only when every source failed; otherwise `ready`. */
  readonly status: "ready" | "unavailable";
  readonly steps: readonly StudioOnboardingStep[];
  readonly done: number;
  readonly total: number;
  readonly unknown: number;
};

const ONBOARDING_TOTAL = 6;

function stateFromFact(
  fact: boolean | number | null,
): StudioOnboardingStepState {
  if (fact === null) return "unknown";
  if (typeof fact === "number") return fact > 0 ? "done" : "todo";
  return fact ? "done" : "todo";
}

export function buildStudioOnboarding(
  facts: StudioOnboardingFacts,
  role: WorkspaceRole,
): StudioOnboardingResult {
  const canOperate = requireWorkspaceRole("operator", role);
  const canAdmin = requireWorkspaceRole("admin", role);
  const canReview = requireWorkspaceRole("reviewer", role);

  const steps: StudioOnboardingStep[] = [
    {
      key: "store",
      state: stateFromFact(facts.connectionPresent),
      owner: "admin",
      href: canAdmin ? "/studio/connections" : null,
    },
    {
      key: "reviewer",
      state: stateFromFact(facts.reviewerCount),
      owner: "admin",
      href: canAdmin ? "/admin" : null,
    },
    {
      key: "catalog",
      state: stateFromFact(facts.listingCount),
      owner: "operator",
      href: canOperate ? "/import" : null,
    },
    {
      key: "review",
      state: stateFromFact(facts.artifactCount),
      owner: "operator",
      href: canOperate ? "/studio/reviews" : null,
    },
    {
      key: "signoff",
      state: stateFromFact(facts.signedOffCount),
      owner: "reviewer",
      href: canReview ? "/studio/outputs" : null,
    },
    {
      key: "export",
      state: stateFromFact(facts.exportCount),
      owner: "operator",
      href: canOperate ? "/batches" : null,
    },
  ];

  const done = steps.filter((step) => step.state === "done").length;
  const unknown = steps.filter((step) => step.state === "unknown").length;

  return {
    status:
      unknown === ONBOARDING_TOTAL && steps.length === ONBOARDING_TOTAL
        ? "unavailable"
        : "ready",
    steps,
    done,
    total: ONBOARDING_TOTAL,
    unknown,
  };
}
