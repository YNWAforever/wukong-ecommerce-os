import { getDatabase as defaultGetDatabase } from "../intake-runtime";
import { isStudioEnabled } from "../studio-flags";
import { authSessionContext } from "../session-context";
import type { StudioSessionDeps } from "./session";
import { requireStudioSession } from "./session";
import {
  buildStudioOnboarding,
  type StudioOnboardingFacts,
  type StudioOnboardingResult,
} from "./onboarding";

/**
 * Read-only setup/plan projections for the Studio home and settings pages.
 *
 * Both methods gate through the shared Studio session (viewer / admin
 * respectively) and read only counts and booleans; member emails and tokens
 * never leave the repository boundary. Per-source failures degrade to `null`
 * so one unreadable table cannot blank the whole card.
 */
export type StudioPlanUsage = {
  readonly members: number | null;
  readonly pendingInvites: number | null;
  readonly catalog: number | null;
};

export type StudioOnboardingService = {
  onboarding(): Promise<StudioOnboardingResult>;
  planUsage(): Promise<StudioPlanUsage>;
};

function fulfilled<T>(result: PromiseSettledResult<T>): T | null {
  return result.status === "fulfilled" ? result.value : null;
}

export function createStudioOnboardingService(
  deps: StudioSessionDeps,
): StudioOnboardingService {
  const database = () => deps.getDatabase();

  return {
    async onboarding() {
      const { session, role } = await requireStudioSession(deps, "viewer");
      const facts = await database().forWorkspace<StudioOnboardingFacts>(
        session.workspaceId,
        async (repos) => {
          const [readiness, members, counts, artifacts, signedOff, exports] =
            await Promise.allSettled([
              repos.workspaces.readinessObservations(),
              repos.memberships.listForWorkspace(),
              repos.listings.countByStatus(),
              repos.studio.outputs.list({ limit: 1 }),
              repos.studio.outputs.list({ limit: 1, status: "signed_off" }),
              repos.exportAttempts.listForWorkspace(20),
            ]);

          const readinessValue = fulfilled(readiness);
          const membersValue = fulfilled(members);
          const countsValue = fulfilled(counts);
          const artifactsValue = fulfilled(artifacts);
          const signedOffValue = fulfilled(signedOff);
          const exportsValue = fulfilled(exports);

          return {
            connectionPresent: readinessValue
              ? readinessValue.connectionPresent
              : null,
            reviewerCount: membersValue
              ? membersValue.filter((member) => member.role === "reviewer")
                  .length
              : null,
            listingCount: countsValue
              ? Object.values(countsValue).reduce((sum, n) => sum + n, 0)
              : null,
            artifactCount: artifactsValue ? artifactsValue.items.length : null,
            signedOffCount: signedOffValue ? signedOffValue.items.length : null,
            // A queued or failed export attempt is not "exported work"; only a
            // ready artifact counts, so the step cannot be completed by a
            // request that never produced a file.
            exportCount: exportsValue
              ? exportsValue.some(
                  (attempt) => attempt.artifactStatus === "ready",
                )
                ? 1
                : 0
              : null,
          };
        },
      );
      return buildStudioOnboarding(facts, role);
    },

    async planUsage() {
      const { session } = await requireStudioSession(deps, "admin");
      return database().forWorkspace<StudioPlanUsage>(
        session.workspaceId,
        async (repos) => {
          const [members, invites, counts] = await Promise.allSettled([
            repos.memberships.listForWorkspace(),
            repos.memberships.listInvites(),
            repos.listings.countByStatus(),
          ]);
          const countsValue = fulfilled(counts);
          return {
            members: fulfilled(members)?.length ?? null,
            pendingInvites: fulfilled(invites)?.length ?? null,
            catalog: countsValue
              ? Object.values(countsValue).reduce((sum, n) => sum + n, 0)
              : null,
          };
        },
      );
    },
  };
}

export function studioOnboardingService(
  deps: StudioSessionDeps = {
    sessionContext: authSessionContext,
    getDatabase: defaultGetDatabase,
    isStudioEnabled,
  },
): StudioOnboardingService {
  return createStudioOnboardingService(deps);
}
