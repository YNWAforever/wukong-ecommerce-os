import { createWineDocumentStore, type Database } from "@wukong/db";
import { getDatabase } from "../../../../lib/intake-runtime";
import { createWineDocumentHandler } from "../../../../lib/website/wine-document-handler";
import { createWineDocumentService } from "../../../../lib/website/wine-document-service";
import type { PublicFetch } from "../../../../lib/website/public-fetch";

export const runtime = "nodejs";

export function createWineEvidenceDocumentPost(deps: {
  getDatabase: () => Pick<Database, "forWorkspace">;
  secret: () => string | undefined;
  publicFetch?: PublicFetch;
  now?: () => Date;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}) {
  const handler = createWineDocumentHandler({
    secret: deps.secret,
    now: deps.now,
    service: (input) =>
      createWineDocumentService({
        store: createWineDocumentStore(deps.getDatabase()),
        publicFetch: deps.publicFetch,
        now: deps.now,
        wait: deps.wait,
      })(input),
  });
  return (request: Request) => handler(request);
}

export const POST = createWineEvidenceDocumentPost({
  getDatabase,
  secret: () => process.env.QUEUE_INGRESS_SECRET,
});
