import { z } from "zod";
import {
  readAdoptedWineDependencies,
  type Database,
  type AdoptedWineDependencies,
} from "@wukong/db";
import { requireSessionContext } from "./route-support";
import type { SessionContextPort } from "./session-context-port";
const coordinates = z
  .object({
    listingId: z.uuid(),
    versionId: z.uuid(),
    inputRevision: z.number().int().positive(),
  })
  .strict();
/** Authenticated read only. Admission callers use the DB repository function in their OWN transaction. */
export async function readAdoptedWineSupport(
  ports: {
    database: Pick<Database, "forWorkspace">;
    session: SessionContextPort;
  },
  raw: unknown,
): Promise<AdoptedWineDependencies> {
  const session = await requireSessionContext(ports.session),
    input = coordinates.parse(raw);
  try {
    return await ports.database.forWorkspace(session.workspaceId, (r) =>
      readAdoptedWineDependencies(r, {
        ...input,
        workspaceId: session.workspaceId,
      }),
    );
  } catch {
    return { status: "unavailable", code: "adopted_evidence_unavailable" };
  }
}
