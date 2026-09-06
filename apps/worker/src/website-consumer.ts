import type { Database } from "@wukong/db";
import {
  WEBSITE_DOCUMENT_PATH,
  websiteJobSchema,
  signQueueRequest,
  type WebsiteJob,
} from "@wukong/jobs";
import { createWorkerDatabase } from "./cloudflare-runtime.js";
import type { WorkerEnv } from "./worker-env.js";
export type WebsiteConsumerOutcome = "ack" | { retryAfterSeconds: number };
type Dependencies = {
  createDatabase?: (env: WorkerEnv) => Pick<Database, "forWorkspace" | "close">;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
};
const active = (state: string) => state === "queued" || state === "running";
const delay = (when: Date, now: Date) =>
  Math.min(
    43200,
    Math.max(1, Math.ceil((when.getTime() - now.getTime()) / 1000)),
  );
export async function consumeWebsiteMessage(
  payload: unknown,
  env: WorkerEnv,
  deps: Dependencies = {},
): Promise<WebsiteConsumerOutcome> {
  const parsed = websiteJobSchema.safeParse(payload);
  if (!parsed.success) return "ack";
  const job = parsed.data;
  const now = deps.now ?? (() => new Date());
  let callback: URL | undefined;
  try {
    if (
      !env.WEBSITE_FETCH_BASE_URL?.trim() ||
      !env.QUEUE_INGRESS_SECRET?.trim()
    )
      throw new Error();
    const origin = new URL(env.WEBSITE_FETCH_BASE_URL);
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== "/" ||
      origin.search ||
      origin.hash ||
      !(
        origin.protocol === "https:" ||
        (origin.protocol === "http:" &&
          ["127.0.0.1", "localhost"].includes(origin.hostname))
      )
    )
      throw new Error();
    callback = new URL(WEBSITE_DOCUMENT_PATH, origin);
  } catch {
    callback = undefined;
  }
  const database = (deps.createDatabase ?? createWorkerDatabase)(env);
  try {
    const scan = await database.forWorkspace(job.workspaceId, (repositories) =>
      repositories.websiteCatalog.getScan(job.scanId),
    );
    if (!scan || !active(scan.state) || scan.revision !== job.revision)
      return "ack";
    const instant = now();
    if (instant >= scan.deadlineAt) {
      await database.forWorkspace(job.workspaceId, (repositories) =>
        repositories.websiteCatalog.claimStep({ ...job, now: instant }),
      );
      return "ack";
    }
    if (!callback) {
      console.error(
        JSON.stringify({
          event: "website.scan_unavailable",
          variable: "WEBSITE_FETCH_BASE_URL",
          scanId: job.scanId,
        }),
      );
      await database.forWorkspace(job.workspaceId, (repositories) =>
        repositories.websiteCatalog.recordDispatch({
          ...job,
          status: "failed",
          now: instant,
        }),
      );
      return { retryAfterSeconds: 60 };
    }
    if (instant < scan.deadlineAt) {
      if (scan.nextEligibleAt > instant)
        return {
          retryAfterSeconds: delay(
            new Date(
              Math.min(
                scan.nextEligibleAt.getTime(),
                scan.deadlineAt.getTime(),
              ),
            ),
            instant,
          ),
        };
      if (scan.leaseExpiresAt && scan.leaseExpiresAt > instant)
        return { retryAfterSeconds: delay(scan.leaseExpiresAt, instant) };
    }
    const step = await database.forWorkspace(job.workspaceId, (repositories) =>
      repositories.websiteCatalog.claimStep({ ...job, now: instant }),
    );
    if (!step) return "ack";
    const body = JSON.stringify({ ...job, leaseToken: step.leaseToken });
    const timestamp = Math.floor(now().getTime() / 1000);
    const signature = await signQueueRequest({
      secret: env.QUEUE_INGRESS_SECRET!.trim(),
      timestamp,
      path: WEBSITE_DOCUMENT_PATH,
      body,
    });
    let response: Response;
    try {
      response = await (deps.fetch ?? globalThis.fetch)(callback, {
        method: "POST",
        // Workerd supports manual, not error; the status allowlist below rejects redirects.
        redirect: "manual",
        headers: {
          "content-type": "application/json",
          "x-wukong-timestamp": String(timestamp),
          "x-wukong-signature": signature,
        },
        body,
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      return { retryAfterSeconds: 60 };
    }
    // Callback state is committed by Node. Never accept response fields as database authority.
    await response.body?.cancel();
    if (![200, 202, 409].includes(response.status))
      return { retryAfterSeconds: 60 };
    const next = await database.forWorkspace(job.workspaceId, (repositories) =>
      repositories.websiteCatalog.getScan(job.scanId),
    );
    if (!next || !active(next.state)) return "ack";
    if (next.revision === job.revision) return { retryAfterSeconds: 60 };
    const nextJob: WebsiteJob = { ...job, revision: next.revision };
    let status: "sent" | "failed" = "sent";
    try {
      await env.LISTING_QUEUE.send(nextJob, {
        delaySeconds: delay(
          new Date(
            Math.min(next.nextEligibleAt.getTime(), next.deadlineAt.getTime()),
          ),
          now(),
        ),
      });
    } catch {
      status = "failed";
    }
    await database.forWorkspace(job.workspaceId, (repositories) =>
      repositories.websiteCatalog.recordDispatch({
        scanId: next.id,
        revision: next.revision,
        status,
        now: now(),
      }),
    );
    return "ack";
  } finally {
    await database.close();
  }
}
