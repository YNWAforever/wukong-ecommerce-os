import Link from "next/link";
import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { StudioOutputCard } from "../../../../../components/studio-output-card";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../../../../../lib/locale";
import {
  authSessionContext,
  requireWorkspaceRole,
} from "../../../../../lib/session-context";
import { ApiError } from "../../../../../lib/route-support";
import { studioCopy } from "../../../../../lib/studio-copy";
import {
  studioOutputReadQuerySchema,
  type GetOutputResult,
} from "../../../../../lib/studio/contracts";
import { studioService } from "../../studio-service";
import styles from "../../../../../components/studio.module.css";

export default async function StudioOutputDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const session = await authSessionContext.resolve();
  if (!session) redirect("/signin?callbackUrl=%2Fstudio%2Foutputs");
  if (!z.uuid().safeParse(id).success) notFound();
  const locale = resolveLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
  );
  const candidate = Object.fromEntries(
    Object.entries(await searchParams).filter(
      ([, value]) => value !== undefined,
    ),
  );
  const parsed = studioOutputReadQuerySchema.safeParse(candidate);
  let detail: GetOutputResult | null = null;
  let error = parsed.success ? null : "invalid";
  if (parsed.success) {
    try {
      detail = await studioService().getOutput(
        id,
        parsed.data.revision === undefined
          ? undefined
          : {
              expectedRevision: parsed.data.revision,
              expectedDigest: parsed.data.digest!,
            },
      );
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 404) notFound();
      error =
        cause instanceof ApiError && cause.status === 409
          ? "invalid"
          : "unavailable";
      if (error === "unavailable")
        console.info(
          JSON.stringify({
            event: "studio_output_detail_read_failed",
            outcome: "failure",
            reason: "unavailable",
          }),
        );
    }
    if (detail && parsed.data.revision === undefined) {
      const current = detail.versions.find(
        (version) => version.revision === detail!.output.currentVersion,
      );
      if (current)
        redirect(
          `/studio/outputs/${encodeURIComponent(id)}?revision=${current.revision}&digest=${encodeURIComponent(current.contentDigest)}`,
        );
      error = "unavailable";
    }
  }
  return (
    <div className={styles["studio-section"]}>
      <h1 className={styles["studio-home-title"]}>
        {studioCopy(locale, "studio.outputs.artifact")}
      </h1>
      <Link className={styles["studio-evidence-link"]} href="/studio/inbox">
        {studioCopy(locale, "studio.outputs.backToInbox")}
      </Link>
      {error ||
      !detail ||
      !parsed.success ||
      parsed.data.revision === undefined ? (
        <p role="alert" className={styles["studio-notice"]}>
          {studioCopy(
            locale,
            error === "invalid"
              ? "studio.outputs.invalidPin"
              : "studio.outputs.loadError",
          )}
        </p>
      ) : (
        <StudioOutputCard
          locale={locale}
          outputId={id}
          versionPin={{
            expectedRevision: parsed.data.revision,
            expectedDigest: parsed.data.digest!,
          }}
          initialDetail={detail}
          canSave={requireWorkspaceRole("operator", session.role)}
          canSignOff={requireWorkspaceRole("reviewer", session.role)}
        />
      )}
    </div>
  );
}
