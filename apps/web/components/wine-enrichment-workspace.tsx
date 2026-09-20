"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { workingBaselineForReview, type SectionKey } from "@wukong/core";
import type { WineProposalDiff } from "@wukong/db";
import type { ListingViewResponse } from "./listing-review-client";
import { WineProposalReview } from "./wine-proposal-review";
import { WineEnrichmentProgress } from "./wine-enrichment-progress";
import { WineIdentityChoice } from "./wine-identity-choice";
import { WineEvidencePanel } from "./wine-evidence-panel";
import { WineContentReview, type WineSectionSave } from "./wine-content-review";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import { wineSectionLabels } from "../lib/review-ui-copy";
const noSections: never[] = [];
type Props = {
  snapshot: ListingViewResponse;
  onRefresh: () => Promise<void>;
  externalDirty: boolean;
  onDirtyChange?: (dirty: boolean) => void;
  disabled?: boolean;
};
export function WineEnrichmentWorkspace({
  snapshot,
  onRefresh,
  externalDirty,
  onDirtyChange,
  disabled = false,
}: Props) {
  const locale = useLocale(),
    t = (zh: string, en: string) => localized(locale, zh, en);
  const progress = snapshot.wineProgress;
  const [proposal, setProposal] = useState<WineProposalDiff | null>(null),
    [loading, setLoading] = useState(false),
    [readError, setReadError] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState<"conflict" | "request" | null>(null),
    [dirty, setDirty] = useState(false),
    [selected, setSelected] = useState<string[]>([]);
  const attempt = useRef<{ signature: string; key: string } | null>(null),
    request = useRef(0);
  const listingId = snapshot.listingId,
    runId = progress?.runId;
  const proposalUrl = runId
    ? `/api/listings/${listingId}/wine-enrichment/proposals/${runId}`
    : null;
  const canReadProposal =
    !!progress &&
    (!!progress.proposal ||
      ["awaiting_adoption", "adopted"].includes(progress.state));
  const read = useCallback(async () => {
    const sequence = ++request.current;
    if (!canReadProposal || !proposalUrl) {
      setProposal(null);
      setSelected([]);
      return;
    }
    setLoading(true);
    setReadError(false);
    try {
      const response = await fetch(proposalUrl, { cache: "no-store" });
      if (!response.ok) throw Error("read_failed");
      const next = (await response.json()) as WineProposalDiff;
      if (sequence === request.current) {
        setProposal(next);
        setSelected([]);
      }
    } catch {
      if (sequence === request.current) {
        setReadError(true);
        setProposal(null);
      }
    } finally {
      if (sequence === request.current) setLoading(false);
    }
  }, [proposalUrl, canReadProposal]);
  useEffect(() => {
    void read();
    return () => {
      request.current++;
    };
  }, [read, snapshot.inputRevision, snapshot.activeVersion?.id]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  const blocked = busy || disabled || externalDirty;
  const inFlight = !!progress && ["queued", "running"].includes(progress.state);
  const input = snapshot.workingInput;
  const baseline = input
    ? workingBaselineForReview(
        input.workingContent,
        input.fieldStates,
        snapshot.activeVersion?.content,
      )
    : null;
  const sections =
    baseline?.workingContent.wineOwnership?.sections ?? noSections;
  async function mutate(url: string, body: unknown, method = "POST") {
    const serialized = JSON.stringify(body),
      signature = method + url + serialized;
    if (attempt.current?.signature !== signature)
      attempt.current = { signature, key: crypto.randomUUID() };
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": attempt.current.key,
        },
        body: serialized,
      });
      if (!response.ok) {
        setError(response.status === 409 ? "conflict" : "request");
        if (response.status === 409) {
          await onRefresh();
          await read();
        }
        throw Error("request_failed");
      }
      // Response versionId can be historical. Only refreshed listing state determines the current version.
      await onRefresh();
      await read();
      attempt.current = null;
    } catch (cause) {
      setError((previous) => previous ?? "request");
      throw cause;
    } finally {
      setBusy(false);
    }
  }
  function guard() {
    return {
      expectedInputRevision: input?.revision ?? snapshot.inputRevision ?? 0,
      baseVersionId: input?.baseVersionId ?? snapshot.activeVersion?.id ?? null,
    };
  }
  async function regenerate(
    mode: "research" | "copy" | "section",
    section?: SectionKey,
  ) {
    if (blocked || dirty || inFlight || !snapshot.permissions.canProcess)
      return;
    await mutate(
      `/api/listings/${listingId}/wine-enrichment${mode === "research" ? "" : "/regenerate"}`,
      { ...guard(), mode, ...(section ? { section } : {}) },
    );
  }
  async function save(body: WineSectionSave) {
    if (blocked || !snapshot.permissions.canEdit)
      throw Error("save_unavailable");
    await mutate(
      `/api/listings/${listingId}/inputs`,
      { ...body, action: "save" },
      "PATCH",
    );
  }
  const act = (work: () => Promise<void>) => {
    void work().catch(() => {});
  };
  if (!progress) return null;
  return (
    <div className="wine-workspace" aria-busy={busy}>
      <WineEnrichmentProgress progress={progress} />
      {error && (
        <p role="alert">
          {error === "conflict"
            ? t(
                "資料或建議已變更。已重新載入最新狀態；請檢查差異及所選欄位。",
                "The inputs or proposal changed. Current state was reloaded; review the differences and selection.",
              )
            : t(
                "未能完成操作。已保留你的修改；請檢查資料並重試。",
                "The operation could not finish. Your edits are retained; check the data and retry.",
              )}
        </p>
      )}
      {externalDirty && (
        <p role="status">
          {t(
            "請先儲存其他表格的修改。",
            "Save changes in the other editor first.",
          )}
        </p>
      )}
      <WineIdentityChoice
        candidates={progress.candidates}
        busy={blocked || dirty || inFlight || !snapshot.permissions.canProcess}
        onConfirm={(candidate) =>
          act(() =>
            mutate(`/api/listings/${listingId}/wine-enrichment/identity`, {
              ...guard(),
              sourceRunId: candidate.runId,
              sourceStage: candidate.stage,
              sourceId: candidate.id,
            }),
          )
        }
      />
      <WineEvidencePanel evidence={progress.evidence} />
      {progress.inspection.length > 0 && (
        <details className="panel">
          <summary>
            {t("檢視已儲存的建議文案", "Inspect persisted proposed copy")}
          </summary>
          {progress.inspection.map((inspection, i) => (
            <article key={i}>
              <h3>
                {inspection.stage} · {inspection.status}
              </h3>
              <p>
                {t(
                  "僅供檢視；使用下方差異選擇及採納。",
                  "Inspection only; use the differences below for explicit adoption.",
                )}
              </p>
              {inspection.content.sections.map((section) => (
                <div key={section.key}>
                  <h4>
                    {t(
                      wineSectionLabels[section.key][0],
                      wineSectionLabels[section.key][1],
                    )}
                  </h4>
                  <p lang="en">{section.en}</p>
                  <p lang="zh-Hant">{section["zh-Hant"]}</p>
                </div>
              ))}
            </article>
          ))}
        </details>
      )}
      {loading && (
        <p role="status">
          {t("正在載入建議差異…", "Loading proposal differences…")}
        </p>
      )}
      {readError && (
        <p role="alert">
          {t("無法載入建議。", "Unable to load proposal.")}{" "}
          <button type="button" onClick={() => void read()}>
            {t("重試", "Retry")}
          </button>
        </p>
      )}
      {proposal && (
        <WineProposalReview
          proposal={proposal}
          selected={selected}
          onSelect={setSelected}
          disabled={blocked || dirty}
          canEdit={snapshot.permissions.canEdit}
          onAdopt={() =>
            act(() =>
              mutate(`${proposalUrl}/adopt`, {
                expectedInputRevision: proposal.inputRevision,
                baseVersionId: proposal.baseVersionId,
                selectedPaths: selected,
              }),
            )
          }
        />
      )}
      {input && (
        <WineContentReview
          sections={sections}
          revision={input.revision}
          baseVersionId={input.baseVersionId}
          canEdit={snapshot.permissions.canEdit && !externalDirty}
          busy={busy || disabled || inFlight}
          onSave={save}
          onDirtyChange={setDirty}
          onRegenerate={(section) => act(() => regenerate("section", section))}
        />
      )}
      <section className="panel">
        <h2>{t("重新處理", "Run again")}</h2>
        <p>
          {t(
            "重新搜尋可能使用網絡搜尋及 Tavily 點數；重新生成文案只使用 AI，不會使用 Tavily 搜尋。",
            "Re-research may use network search and Tavily credits. Copy regeneration uses AI only, with no Tavily search.",
          )}
        </p>
        <button
          type="button"
          disabled={
            blocked || dirty || inFlight || !snapshot.permissions.canProcess
          }
          onClick={() => act(() => regenerate("research"))}
        >
          {t("重新搜尋資料", "Re-research")}
        </button>{" "}
        <button
          type="button"
          disabled={
            blocked || dirty || inFlight || !snapshot.permissions.canProcess
          }
          onClick={() => act(() => regenerate("copy"))}
        >
          {t("重新生成全部文案（不搜尋）", "Regenerate all copy (no search)")}
        </button>
      </section>
    </div>
  );
}
