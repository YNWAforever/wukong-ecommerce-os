import type { WebsiteScan } from "@wukong/db";
import { WEBSITE_INGRESS_PATH, type WebsiteJob } from "@wukong/jobs";
import { QueueIngressError } from "../cloudflare-queue-runtime";
import { ApiError } from "../route-support";
import type { WebsiteDatabase } from "./scan-service";

export type WebsiteDispatchDeps = {
  getDatabase: () => WebsiteDatabase;
  enqueue: (job: WebsiteJob) => Promise<unknown>;
  now?: () => Date;
};
/** Claims and commits before sending; only persisted readback is returned to callers. */
export async function dispatchWebsiteScan(
  deps: WebsiteDispatchDeps,
  scan: WebsiteScan,
  session: { workspaceId: string; actorId: string },
) {
  const database = deps.getDatabase();
  const claimed = await database.forWorkspace(
    session.workspaceId,
    (repositories) =>
      repositories.websiteCatalog.claimDispatch({
        scanId: scan.id,
        revision: scan.revision,
        expectedAttempts: scan.dispatchAttempts,
        actorId: session.actorId,
        now: deps.now?.() ?? new Date(),
      }),
  );
  if (claimed) {
    let status: "sent" | "failed" = "sent";
    try {
      await deps.enqueue({
        kind: "website_scan",
        workspaceId: session.workspaceId,
        scanId: claimed.id,
        revision: claimed.revision,
      });
    } catch (error) {
      status = "failed";
      console.info(
        JSON.stringify({
          event: "website.scan_dispatch_failed",
          ingressPath: WEBSITE_INGRESS_PATH,
          reason: error instanceof QueueIngressError ? error.reason : "unknown",
        }),
      );
    }
    await database.forWorkspace(session.workspaceId, (repositories) =>
      repositories.websiteCatalog.recordDispatch({
        scanId: claimed.id,
        revision: claimed.revision,
        expectedAttempts: claimed.dispatchAttempts,
        actorId: session.actorId,
        status,
        now: deps.now?.() ?? new Date(),
      }),
    );
  }
  const current = await database.forWorkspace(
    session.workspaceId,
    (repositories) => repositories.websiteCatalog.getScan(scan.id),
  );
  if (!current) throw new ApiError(404, "scan_not_found", "Scan not found.");
  return { claimed: Boolean(claimed), scan: current };
}
