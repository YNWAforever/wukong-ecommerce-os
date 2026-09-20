"use client";
import type { Dispatch, SetStateAction } from "react";
import type { WineProposalDiff } from "@wukong/db";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import { wineSectionLabels, evidenceFieldLabel } from "../lib/review-ui-copy";
function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.map(displayValue).join(", ");
  if (typeof value === "object")
    return Object.entries(value)
      .map(
        ([key, item]) =>
          `${key === "en" ? "English" : key === "zh-Hant" ? "繁體中文" : key}: ${displayValue(item)}`,
      )
      .join("\n\n");
  return String(value);
}
export function WineProposalReview({
  proposal,
  selected,
  onSelect,
  onAdopt,
  disabled,
  canEdit,
}: {
  proposal: WineProposalDiff;
  selected: string[];
  onSelect: Dispatch<SetStateAction<string[]>>;
  onAdopt: () => void;
  disabled: boolean;
  canEdit: boolean;
}) {
  const locale = useLocale(),
    t = (zh: string, en: string) => localized(locale, zh, en);
  return (
    <section className="panel">
      <h2>{t("採納前比較差異", "Compare differences before adoption")}</h2>
      <p>
        {t("目前版本", "Current version")}:{" "}
        <code>
          {proposal.current.activeVersionId ?? t("尚未建立", "Not created")}
        </code>
      </p>
      {proposal.adoptedVersionId && (
        <p>
          {t("歷史採納版本", "Historical adopted version")}:{" "}
          <code>{proposal.adoptedVersionId}</code>
        </p>
      )}
      {proposal.state !== "available" && (
        <p role="status">
          {proposal.state === "adopted"
            ? t("此建議已採納。", "This proposal was adopted.")
            : t(
                "此建議目前不可採納，請重新搜尋或檢查最新資料。",
                "This proposal is currently unavailable; research again or check current data.",
              )}{" "}
          {proposal.reason}
        </p>
      )}
      {!proposal.differences.length && (
        <p>{t("沒有可比較的差異。", "No differences are available.")}</p>
      )}
      {proposal.differences.map((row) => (
        <fieldset
          key={row.path}
          disabled={
            disabled ||
            proposal.state !== "available" ||
            !row.selectable ||
            !canEdit
          }
        >
          <legend>
            <label>
              <input
                type="checkbox"
                data-proposal-path={row.path}
                checked={selected.includes(row.path)}
                onChange={(event) =>
                  onSelect((items) =>
                    event.target.checked
                      ? [...items, row.path]
                      : items.filter((path) => path !== row.path),
                  )
                }
              />
              {row.kind === "section" && row.path.slice(9) in wineSectionLabels
                ? wineSectionLabels[
                    row.path.slice(9) as keyof typeof wineSectionLabels
                  ][locale === "en" ? 1 : 0]
                : evidenceFieldLabel(row.path, locale)}
            </label>
          </legend>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fit,minmax(220px,1fr))",
              gap: 16,
            }}
          >
            <div>
              <strong>{t("目前內容", "Before")}</strong>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {displayValue(row.before)}
              </pre>
            </div>
            <div>
              <strong>{t("建議內容", "After")}</strong>
              <pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                {displayValue(row.after)}
              </pre>
            </div>
          </div>
          {JSON.stringify(row.before) === JSON.stringify(row.after) && (
            <p>{t("內容相同，仍可選擇", "Unchanged; still selectable")}</p>
          )}
          {row.reason && <p>{row.reason}</p>}
        </fieldset>
      ))}
      {proposal.state === "available" && (
        <>
          <p>
            {t(
              "每個段落會同時採納兩種語言。伺服器會再次核對所選組合。",
              "Each section adopts both languages together. The server rechecks the selected combination.",
            )}
          </p>
          <button
            className="secondary-button"
            type="button"
            data-action="adopt-wine"
            disabled={disabled || !selected.length || !canEdit}
            onClick={onAdopt}
          >
            {t("採納所選差異", "Adopt selected differences")}
          </button>
        </>
      )}
    </section>
  );
}
