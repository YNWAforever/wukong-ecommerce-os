import { z } from "zod";
import {
  createFreshExportVerificationService,
  MAX_VERIFICATION_UPLOAD_BYTES,
} from "../../../../../../lib/fresh-export-verification";
import {
  getDatabase,
  getAssetStore,
} from "../../../../../../lib/intake-runtime";
import {
  ApiError,
  jsonResponse,
  requireSessionContext,
  withRouteErrors,
} from "../../../../../../lib/route-support";
import { authSessionContext } from "../../../../../../lib/session-context";
import type { SessionContextPort } from "../../../../../../lib/session-context-port";
export const runtime = "nodejs";
type Context = { params: Promise<{ id: string }> };
async function boundedBody(request: Request): Promise<Uint8Array> {
  const tooLarge = () =>
    new ApiError(
      413,
      "comparison_upload_too_large",
      "The workbook exceeds the 4 MiB upload limit.",
    );
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > MAX_VERIFICATION_UPLOAD_BYTES)
    throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_VERIFICATION_UPLOAD_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
export function createFreshExportVerificationHandlers(deps: {
  sessionContext: SessionContextPort;
  service: ReturnType<typeof createFreshExportVerificationService>;
}) {
  async function auth(context: Context) {
    const session = await requireSessionContext(deps.sessionContext);
    if (!["reviewer", "admin", "owner"].includes(session.role))
      throw new ApiError(
        403,
        "insufficient_role",
        "Reviewer access is required.",
      );
    const { id } = await context.params;
    if (!z.uuid().safeParse(id).success)
      throw new ApiError(
        404,
        "export_attempt_not_found",
        "Export attempt not found.",
      );
    return { session, id };
  }
  const protect = (work: () => Promise<Response>) =>
    withRouteErrors(async () => {
      try {
        return await work();
      } catch (error) {
        if (error instanceof ApiError) throw error;
        throw new ApiError(
          503,
          "comparison_unavailable",
          "The snapshot comparison is unavailable. Retry later.",
        );
      }
    });
  return {
    POST: (request: Request, context: Context) =>
      protect(async () => {
        const { session, id } = await auth(context),
          query = new URL(request.url).searchParams;
        const result = await deps.service.record({
          workspaceId: session.workspaceId,
          actorId: session.actorId,
          exportAttemptId: id,
          filename: query.get("filename") ?? "",
          merchantAttestedExportAt: query.get("merchantAttestedExportAt") ?? "",
          sameStoreAttested: query.get("sameStoreAttested") === "true",
          body: await boundedBody(request),
        });
        return jsonResponse(result.replayed ? 200 : 201, result);
      }),
    GET: (request: Request, context: Context) =>
      protect(async () => {
        const { session, id } = await auth(context),
          query = new URL(request.url).searchParams;
        const verificationId = query.get("verificationId");
        if (verificationId !== null) {
          if (!z.uuid().safeParse(verificationId).success)
            throw new ApiError(
              400,
              "invalid_verification_id",
              "Comparison reference is invalid.",
            );
          return jsonResponse(
            200,
            await deps.service.detail({
              workspaceId: session.workspaceId,
              exportAttemptId: id,
              verificationId,
            }),
          );
        }
        const page = Number(query.get("page") ?? "1"),
          pageSize = Number(query.get("pageSize") ?? "10");
        if (
          !Number.isSafeInteger(page) ||
          page < 1 ||
          page > 1000000 ||
          !Number.isInteger(pageSize) ||
          pageSize < 1 ||
          pageSize > 20
        )
          throw new ApiError(
            400,
            "invalid_pagination",
            "Comparison page is invalid.",
          );
        return jsonResponse(
          200,
          await deps.service.history({
            workspaceId: session.workspaceId,
            exportAttemptId: id,
            page,
            pageSize,
          }),
        );
      }),
  };
}
const handlers = createFreshExportVerificationHandlers({
  sessionContext: authSessionContext,
  service: createFreshExportVerificationService({ getDatabase, getAssetStore }),
});
export const POST = handlers.POST;
export const GET = handlers.GET;
