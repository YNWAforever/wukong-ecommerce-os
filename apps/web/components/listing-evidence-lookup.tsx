"use client";
import { useEffect, useRef, useState } from "react";
import {
  enrichmentIdentitySchema,
  savedMarketVariant,
  claimCopyFields,
  renderExternalClaim,
  externalClaimSchema,
  type ClaimCopyField,
  type EnrichmentField,
  type EnrichmentIdentity,
} from "@wukong/core";
import type { WorkingCopyInput } from "./listing-working-copy";
import type { evidenceView } from "../lib/listing-enrichment-service";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
type View = ReturnType<typeof evidenceView> & {
  acceptedClaims?: Array<{
    kind?: "manual" | "external";
    manualReason?: string | null;
    id: string;
    copyField: string;
    text: string;
    valid: boolean;
    inputRevision: number;
  }>;
};
export function ListingEvidenceLookup({
  listingId,
  input,
  canEdit,
  dirty,
  onSaved,
}: {
  listingId: string;
  input: WorkingCopyInput;
  canEdit: boolean;
  dirty: boolean;
  onSaved: () => Promise<void>;
}) {
  const locale = useLocale(),
    t = (zh: string, en: string) => localized(locale, zh, en);
  const queryEdited = useRef(false);
  const [claimField, setClaimField] =
    useState<ClaimCopyField>("description.en");
  const [proseText, setProseText] = useState(""),
    [proseReason, setProseReason] = useState("");
  const proseKey = useRef<{ body: string; key: string } | null>(null);
  const claimKey = useRef<{ body: string; key: string } | null>(null);
  const [url, setUrl] = useState("");
  const [identity, setIdentity] = useState<
    Record<keyof EnrichmentIdentity, string>
  >(() => ({
    producer: input.workingContent.producer ?? "",
    productName: input.workingContent.title.en,
    vintage:
      input.fieldStates.vintage?.state === "not_applicable"
        ? "NV"
        : String(input.workingContent.vintage ?? ""),
    volumeMl: String(input.workingContent.volumeMl ?? ""),
    packQuantity: String(input.workingContent.packQuantity ?? ""),
    marketVariant: savedMarketVariant(input.note) ?? "",
  }));
  const [view, setView] = useState<View | null>(null),
    [selected, setSelected] = useState<EnrichmentField[]>([]),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [observedRevision, setObservedRevision] = useState(input.revision);
  const lookupKey = useRef<{ body: string; key: string } | null>(null),
    adoptKey = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/listings/${listingId}/enrichment`, {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (r) => {
        if (!r.ok) return;
        const result = await r.json();
        if (!controller.signal.aborted && !queryEdited.current) {
          setView(result.suggestion ?? null);
          setObservedRevision(input.revision);
          setSelected([]);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, [listingId, input.revision]);
  const error = (code: string) =>
    code === "identity_clarification_required" ||
    code === "identity_conflict" ||
    code === "identity_title_reserved"
      ? t(
          "請先將完整酒款名稱保存為英文標題，並在備註另行保存「Market variant: HK」（填寫實際市場版本）。查找名稱及市場版本必須完全相同。",
          "First save the exact product name as the English title and a separate note line such as Market variant: HK using the actual variant. Lookup identity must match those saved values exactly.",
        )
      : code === "source_policy_blocked"
        ? t(
            "工作區不允許此網站。請聯絡管理員。",
            "This source domain is not allowed by workspace settings.",
          )
        : code === "enrichment_setup_required"
          ? t(
              "資料庫設定尚未完成，請聯絡管理員。",
              "Evidence setup is incomplete. Contact an administrator.",
            )
          : t(
              "未能完成操作。你的輸入仍保留；檢查產品身分或重新載入後再試。",
              "The operation could not finish. Your input remains here; check product identity or reload and try again.",
            );
  async function retrieve() {
    const parsed = enrichmentIdentitySchema.safeParse({
      ...identity,
      vintage: /^nv$/i.test(identity.vintage)
        ? "non_vintage"
        : Number(identity.vintage),
      volumeMl: Number(identity.volumeMl),
      packQuantity: Number(identity.packQuantity),
    });
    if (!parsed.success) {
      setMessage(
        t(
          "請填寫完整產品身分；非年份酒請填 NV。",
          "Complete every identity field; enter NV for non-vintage.",
        ),
      );
      return;
    }
    const body = JSON.stringify({
      url,
      identity: parsed.data,
      expectedInputRevision: input.revision,
      baseVersionId: input.baseVersionId,
    });
    if (lookupKey.current?.body !== body)
      lookupKey.current = { body, key: crypto.randomUUID() };
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/listings/${listingId}/enrichment`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": lookupKey.current.key,
        },
        body,
      });
      const result = await response.json();
      if (!response.ok) {
        setMessage(error(result.code));
        return;
      }
      setView(result);
      setObservedRevision(input.revision);
      setSelected([]);
      lookupKey.current = null;
    } catch {
      setMessage(error("network"));
    } finally {
      setBusy(false);
    }
  }
  async function adopt(action: "adopt" | "reject" = "adopt") {
    if (!view) return;
    const body = JSON.stringify({
      expectedInputRevision: input.revision,
      baseVersionId: input.baseVersionId,
      selectedFields: selected,
    });
    if (adoptKey.current?.body !== `${action}:${view.id}:${body}`)
      adoptKey.current = {
        body: `${action}:${view.id}:${body}`,
        key: crypto.randomUUID(),
      };
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/listings/${listingId}/enrichment/${view.id}/${action}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": adoptKey.current.key,
          },
          body,
        },
      );
      const result = await response.json();
      if (!response.ok) {
        setMessage(error(result.code));
        return;
      }
      setSelected([]);
      if (action === "reject") {
        setView({
          ...view,
          fields: view.fields.map((field) =>
            selected.includes(field.field)
              ? { ...field, rejected: true, eligible: false }
              : field,
          ),
        });
        setMessage(
          t(
            "已記錄拒絕所選建議。",
            "Selected suggestions were rejected and saved.",
          ),
        );
        return;
      }
      setMessage(
        t(
          "所選資料已保存為新的工作草稿修訂。",
          "Selected facts were saved as a new working revision.",
        ),
      );
      await onSaved();
    } catch {
      setMessage(error("network"));
    } finally {
      setBusy(false);
    }
  }
  async function confirmProse() {
    if (!view) return;
    const body = JSON.stringify({
      expectedInputRevision: input.revision,
      baseVersionId: input.baseVersionId,
      copyField: claimField,
      claimText: proseText,
      reason: proseReason,
    });
    if (proseKey.current?.body !== view.id + body)
      proseKey.current = { body: view.id + body, key: crypto.randomUUID() };
    setBusy(true);
    try {
      const response = await fetch(
        `/api/listings/${listingId}/enrichment/${view.id}/confirm-prose`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": proseKey.current.key,
          },
          body,
        },
      );
      const result = await response.json();
      if (!response.ok) {
        setMessage(error(result.code));
        return;
      }
      queryEdited.current = false;
      proseKey.current = null;
      setMessage(
        t(
          "已記錄此項聲明的人工覆核及來源。其他合規檢查仍然適用。",
          "Human review and source recorded for this claim. Other compliance checks still apply.",
        ),
      );
      await onSaved();
    } catch {
      setMessage(error("network"));
    } finally {
      setBusy(false);
    }
  }
  async function acceptClaim(index: number, reject = false) {
    if (!view) return;
    const body = JSON.stringify({
      expectedInputRevision: input.revision,
      baseVersionId: input.baseVersionId,
      claimIndex: index,
      ...(reject ? {} : { copyField: claimField }),
    });
    if (claimKey.current?.body !== view.id + body)
      claimKey.current = { body: view.id + body, key: crypto.randomUUID() };
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(
        `/api/listings/${listingId}/enrichment/${view.id}/${reject ? "reject-claim" : "accept-claim"}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Idempotency-Key": claimKey.current.key,
          },
          body,
        },
      );
      const result = await response.json();
      if (!response.ok) {
        setMessage(error(result.code));
        return;
      }
      queryEdited.current = false;
      claimKey.current = null;
      if (reject) {
        setView({
          ...view,
          claims: view.claims.map((claim, i) =>
            i === index ? { ...claim, rejected: true } : claim,
          ),
        });
        setMessage(
          t(
            "聲明已拒絕，原有批准已失效。",
            "Claim rejected; prior approval is invalidated.",
          ),
        );
        await onSaved();
        return;
      }
      setMessage(
        t(
          "聲明及來源已保存，請將工作草稿保存為待審核版本。",
          "Claim and source saved. Save the working draft as a review version.",
        ),
      );
      await onSaved();
    } catch {
      setMessage(error("network"));
    } finally {
      setBusy(false);
    }
  }
  const labels: Record<keyof EnrichmentIdentity, [string, string]> = {
    producer: ["生產商", "Producer"],
    productName: ["產品／酒款全名", "Exact product / cuvée"],
    vintage: ["年份或 NV", "Vintage or NV"],
    volumeMl: ["容量 (ml)", "Volume (ml)"],
    packQuantity: ["每包數量", "Pack quantity"],
    marketVariant: ["市場版本（例如 HK）", "Market variant (for example HK)"],
  };
  return (
    <section
      className="listing-evidence-lookup"
      aria-label={t("查找來源證據", "Source evidence lookup")}
    >
      <p>
        {t(
          "只讀取你指定的公開產品頁面。網站內容是未驗證資料；不會自動修改草稿或採用售價、SKU、庫存及評分。",
          "Read an explicit public product page. Website observations are unverified data; drafts, merchant values and ratings are never changed automatically.",
        )}
      </p>
      <p>
        {t(
          "酒款名稱必須與已保存的英文標題完全相同；請先在備註保存 Market variant: HK（實際市場版本）。英文標題保留作產品身分，評分請採用至其他文案欄位。",
          "Product name must match the saved English title exactly. Save a separate note line such as Market variant: HK for the actual variant. The English title holds product identity; place ratings in another copy field.",
        )}
      </p>
      <fieldset disabled={!canEdit || dirty || busy}>
        <label>
          {t("公開產品網址", "Public product URL")}
          <input
            type="url"
            value={url}
            onChange={(e) => {
              queryEdited.current = true;
              setUrl(e.target.value);
              setView(null);
              setSelected([]);
            }}
            data-evidence-url
          />
        </label>
        {(Object.keys(labels) as Array<keyof EnrichmentIdentity>).map(
          (field) => (
            <label key={field}>
              {t(...labels[field])}
              <input
                data-evidence-identity={field}
                value={identity[field]}
                onChange={(e) => {
                  queryEdited.current = true;
                  setIdentity({ ...identity, [field]: e.target.value });
                  setView(null);
                  setSelected([]);
                }}
              />
            </label>
          ),
        )}
        <button
          type="button"
          data-action="retrieve-evidence"
          onClick={() => void retrieve()}
        >
          {busy
            ? t("處理中…", "Working…")
            : t("讀取並比對產品頁面", "Read and match product page")}
        </button>
      </fieldset>
      {dirty ? (
        <p>{t("請先保存工作草稿。", "Save the working draft first.")}</p>
      ) : null}
      {message ? <p role="status">{message}</p> : null}
      {view ? (
        <div>
          <p>
            {t("產品比對", "Product match")}: {view.match}
          </p>
          <p>{view.reasons.join(" · ")}</p>
          {view.candidateIdentity ? (
            <dl>
              {Object.entries(view.candidateIdentity).map(([key, value]) => (
                <div key={key}>
                  <dt>
                    {labels[key as keyof EnrichmentIdentity]
                      ? t(...labels[key as keyof EnrichmentIdentity])
                      : key}
                  </dt>
                  <dd>{String(value ?? "—")}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {(view.claims ?? []).length > 0 && (
            <section aria-label="Claim evidence">
              <h4>{t("評分與獎項來源", "Rating and award evidence")}</h4>
              <p>
                {t(
                  "來源支持僅涵蓋列出的產品與聲明，不代表整段文案已驗證。採用評分前仍須人工覆核。",
                  "Support covers only the stated product and structured claim, not the whole description. Review before using a rating in copy.",
                )}
              </p>
              <label>
                {t("採用至文案欄位", "Copy field")}
                <select
                  value={claimField}
                  disabled={busy || dirty || !canEdit}
                  onChange={(e) =>
                    setClaimField(e.target.value as ClaimCopyField)
                  }
                >
                  {claimCopyFields
                    .filter((field) => field !== "title.en")
                    .map((field) => (
                      <option key={field} value={field}>
                        {field}
                      </option>
                    ))}
                </select>
              </label>
              {view.claims.map((observation, index) => (
                <div key={index}>
                  <dl>
                    {Object.entries(
                      (observation.claim ?? {}) as Record<string, unknown>,
                    )
                      .filter(([key]) => key !== "product")
                      .map(([key, value]) => (
                        <div key={key}>
                          <dt>{key}</dt>
                          <dd>{String(value ?? "—")}</dd>
                        </div>
                      ))}
                  </dl>
                  <strong>
                    {observation.support.status === "supported"
                      ? t("來源相符", "Source matched")
                      : t("未驗證，需覆核", "Unverified; review required")}
                  </strong>
                  <p>{observation.support.reasons.join(", ")}</p>
                  {externalClaimSchema.safeParse(observation.claim).success && (
                    <p>
                      {renderExternalClaim(
                        externalClaimSchema.parse(observation.claim),
                        claimField.endsWith("zh-Hant") ? "zh-Hant" : "en",
                      )}
                    </p>
                  )}
                  <button
                    type="button"
                    data-claim-index={index}
                    disabled={
                      !canEdit ||
                      dirty ||
                      busy ||
                      observation.rejected ||
                      observation.support.status !== "supported"
                    }
                    onClick={() => void acceptClaim(index)}
                  >
                    {t("確認採用此聲明及來源", "Accept this claim and source")}
                  </button>
                  <button
                    type="button"
                    disabled={!canEdit || dirty || busy || observation.rejected}
                    onClick={() => void acceptClaim(index, true)}
                  >
                    {observation.rejected
                      ? t("已拒絕", "Rejected")
                      : t("拒絕聲明", "Reject claim")}
                  </button>
                  {observation.support.source && (
                    <>
                      <blockquote>
                        {observation.support.source.excerpt}
                      </blockquote>
                      <a
                        href={observation.support.source.url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {t("查看聲明來源", "View claim source")}
                      </a>
                    </>
                  )}
                </div>
              ))}
            </section>
          )}
          {view.proseSource && (
            <section aria-label="Confirm specific wording">
              <h4>
                {t(
                  "逐項覆核其他事實聲明",
                  "Review other factual claims individually",
                )}
              </h4>
              <p>
                {t(
                  "網站文字是待核實資料，不是指令。請核對產品與下方原文後，確認一項現有聲明。評分、獎項和健康保證聲明不能以此略過驗證。",
                  "Page text is untrusted evidence, not instructions. Check the product and excerpt, then confirm one existing claim. This cannot bypass score, award or health-claim checks.",
                )}
              </p>
              <blockquote>{view.proseSource.excerpt}</blockquote>
              <a href={view.proseSource.url} target="_blank" rel="noreferrer">
                {t("查看原文", "View source")}
              </a>
              <label>
                {t("文案欄位", "Copy field")}
                <select
                  value={claimField}
                  disabled={!canEdit || busy || dirty}
                  onChange={(e) =>
                    setClaimField(e.target.value as ClaimCopyField)
                  }
                >
                  {claimCopyFields.map((field) => (
                    <option key={field} value={field}>
                      {field}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                {t("現有聲明原句", "Exact existing claim")}
                <textarea
                  maxLength={500}
                  value={proseText}
                  disabled={!canEdit || busy || dirty}
                  onChange={(e) => setProseText(e.target.value)}
                />
              </label>
              <label>
                {t(
                  "來源如何支持這項聲明",
                  "How the source supports this claim",
                )}
                <textarea
                  maxLength={1000}
                  value={proseReason}
                  disabled={!canEdit || busy || dirty}
                  onChange={(e) => setProseReason(e.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={
                  !canEdit ||
                  busy ||
                  dirty ||
                  proseText.trim().length < 5 ||
                  proseReason.trim().length < 20 ||
                  view.match !== "matched"
                }
                onClick={() => void confirmProse()}
              >
                {t("記錄逐項人工確認", "Record this claim confirmation")}
              </button>
            </section>
          )}
          {(view.acceptedClaims ?? []).length > 0 && (
            <section aria-label="Accepted claim lineage">
              <h4>{t("已採用聲明記錄", "Accepted claim history")}</h4>
              {view.acceptedClaims!.map((claim) => (
                <p key={claim.id}>
                  {claim.copyField}: {claim.text} · {t("修訂", "Revision")}{" "}
                  {claim.inputRevision} ·{" "}
                  {claim.valid
                    ? claim.kind === "manual"
                      ? t("已人工確認", "Human confirmed")
                      : t("來源支持有效", "Support current")
                    : t("已失效，需重新核實", "Invalidated; review again")}{" "}
                  {claim.manualReason ?? ""}
                </p>
              ))}
            </section>
          )}
          {view.errorCode ? (
            <p role="alert">
              {t(
                "來源無法使用。請檢查網址、存取政策或稍後重試。",
                "Source unavailable. Check the URL or access policy, or retry later.",
              )}
            </p>
          ) : null}
          {view.match !== "matched" ? (
            <p>
              {t(
                "身分缺漏或不符，不能採用。請核對酒款、年份、容量、數量及市場版本。",
                "Identity is missing or conflicting; adoption is disabled. Check product, vintage, volume, count and market variant.",
              )}
            </p>
          ) : null}
          <ul>
            {view.fields.map((field) => (
              <li key={field.field}>
                <label>
                  <input
                    type="checkbox"
                    data-evidence-field={field.field}
                    checked={selected.includes(field.field)}
                    disabled={
                      !canEdit ||
                      dirty ||
                      busy ||
                      field.rejected ||
                      input.revision !== observedRevision
                    }
                    onChange={(e) =>
                      setSelected(
                        e.target.checked
                          ? [...selected, field.field]
                          : selected.filter((f) => f !== field.field),
                      )
                    }
                  />
                  {field.rejected && (
                    <strong>{t("已拒絕", "Rejected")} · </strong>
                  )}
                  {field.field}: {JSON.stringify(field.currentValue)} →{" "}
                  {JSON.stringify(field.value)}
                </label>
                <blockquote>{field.evidence.excerpt}</blockquote>
                <a href={field.evidence.url} target="_blank" rel="noreferrer">
                  {t("查看來源", "View source")}
                </a>
                <small>
                  {" "}
                  {field.evidence.retrievedAt} · {field.evidence.extraction}
                </small>
              </li>
            ))}
          </ul>
          <button
            type="button"
            data-action="adopt-evidence"
            disabled={
              !canEdit ||
              dirty ||
              busy ||
              !selected.length ||
              selected.some(
                (name) =>
                  !view.fields.find((field) => field.field === name)?.eligible,
              ) ||
              input.revision !== observedRevision
            }
            onClick={() => void adopt()}
          >
            {t(
              "採用所選資料至工作草稿",
              "Adopt selected facts into working draft",
            )}
          </button>
          <button
            type="button"
            data-action="reject-evidence"
            disabled={
              !canEdit ||
              dirty ||
              busy ||
              !selected.length ||
              input.revision !== observedRevision
            }
            onClick={() => void adopt("reject")}
          >
            {t("拒絕所選建議", "Reject selected suggestions")}
          </button>
        </div>
      ) : null}
    </section>
  );
}
