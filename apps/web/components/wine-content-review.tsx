"use client";
import { useEffect, useState } from "react";
import type {
  ContentSection,
  WineSectionChange,
  SectionKey,
} from "@wukong/core";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import {
  readWineSectionDraft,
  writeWineSectionDraft,
} from "../lib/wine-section-draft";
import { wineSectionLabels } from "../lib/review-ui-copy";
export type WineSectionSave = {
  expectedInputRevision: number;
  baseVersionId: string | null;
  sectionChanges: WineSectionChange[];
};
type Props = {
  sections: ContentSection[];
  draftKey?: string;
  revision: number;
  baseVersionId: string | null;
  canEdit: boolean;
  busy: boolean;
  onSave: (body: WineSectionSave) => Promise<void>;
  onRegenerate: (key: SectionKey) => void | Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
};
export function WineContentReview({
  sections,
  draftKey,
  revision,
  baseVersionId,
  canEdit,
  busy,
  onSave,
  onRegenerate,
  onDirtyChange,
}: Props) {
  const locale = useLocale(),
    t = (zh: string, en: string) => localized(locale, zh, en);
  const [base, setBase] = useState({ sections, revision, baseVersionId }),
    [draft, setDraft] = useState(sections),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(false),
    [loadedKey, setLoadedKey] = useState<string | null>(null),
    [recovered, setRecovered] = useState(false),
    [storageError, setStorageError] = useState(false);
  const storageReady = !draftKey || loadedKey === draftKey;
  useEffect(() => {
    if (!draftKey) return;
    const stored = readWineSectionDraft(draftKey);
    if (stored.state === "recovered") {
      const restore = (values: WineSectionChange[]): ContentSection[] =>
        values.map((value) => ({
          ...(sections.find((section) => section.key === value.key) ?? {
            key: value.key,
            en: "",
            "zh-Hant": "",
            locked: false,
            owner: "operator" as const,
            claimIds: [],
          }),
          ...value,
        }));
      setBase({
        sections: restore(stored.draft.baseline),
        revision: stored.draft.expectedInputRevision,
        baseVersionId: stored.draft.baseVersionId,
      });
      setDraft(restore(stored.draft.sections));
      setRecovered(true);
    }
    setStorageError(stored.state === "unavailable");
    setLoadedKey(draftKey);
    // A draft belongs to one authorized listing; server refreshes must not reload it.
  }, [draftKey]);
  const changes = draft
    .filter((s) => {
      const old = base.sections.find((x) => x.key === s.key);
      return (
        old &&
        (s.en !== old.en ||
          s["zh-Hant"] !== old["zh-Hant"] ||
          s.locked !== old.locked)
      );
    })
    .map(({ key, en, locked, ...section }) => ({
      key,
      en,
      "zh-Hant": section["zh-Hant"],
      locked,
    }));
  const dirty = changes.length > 0;
  useEffect(() => {
    if (!draftKey || !storageReady) return;
    const text = (values: ContentSection[]) =>
      values.map(({ key, en, locked, ...section }) => ({
        key,
        en,
        "zh-Hant": section["zh-Hant"],
        locked,
      }));
    const saved = writeWineSectionDraft(
      draftKey,
      dirty
        ? {
            schemaVersion: 1,
            expectedInputRevision: base.revision,
            baseVersionId: base.baseVersionId,
            baseline: text(base.sections),
            sections: text(draft),
          }
        : null,
    );
    if (!saved) setStorageError(true);
  }, [draftKey, storageReady, dirty, base, draft]);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (storageReady && !dirty && !saving) {
      setBase({ sections, revision, baseVersionId });
      setDraft(sections);
    }
  }, [sections, revision, baseVersionId, dirty, saving, storageReady]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const navigate = (event: MouseEvent) => {
      const link = (event.target as Element).closest?.("a[href]");
      if (
        link &&
        link.getAttribute("target") !== "_blank" &&
        !window.confirm(
          t(
            "離開此頁？未儲存的段落會保留在此分頁（若瀏覽器儲存可用）。",
            "Leave this page? Unsaved paragraphs stay in this tab when browser storage is available.",
          ),
        )
      ) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", warn);
    document.addEventListener("click", navigate, true);
    return () => {
      window.removeEventListener("beforeunload", warn);
      document.removeEventListener("click", navigate, true);
    };
  }, [dirty, locale]);
  async function save() {
    setSaving(true);
    setError(false);
    try {
      await onSave({
        expectedInputRevision: base.revision,
        baseVersionId: base.baseVersionId,
        sectionChanges: changes,
      });
      if (draftKey && !writeWineSectionDraft(draftKey, null))
        setStorageError(true);
      setRecovered(false);
      setBase({ sections: draft, revision, baseVersionId });
      onDirtyChange?.(false);
    } catch {
      setError(true);
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="panel" aria-busy={busy || saving}>
      <h2>{t("雙語段落", "Bilingual sections")}</h2>
      {recovered && (
        <p role="status">
          {t(
            "已還原此分頁未儲存的段落。儲存時仍會核對原有版本；你亦可明確放棄修改。",
            "Recovered unsaved paragraphs from this tab. Saving still checks the original revision; you can explicitly discard the edits.",
          )}
        </p>
      )}
      {storageError && (
        <p role="alert">
          {t(
            "本機草稿復原不可用。離開前請儲存或複製修改，以免遺失。",
            "Local draft recovery is unavailable. Save or copy your edits before leaving to avoid losing them.",
          )}
        </p>
      )}
      <p>
        {t(
          "儲存修改後，此段落由你管理。重新生成其他段落不會更改已儲存的修改。",
          "Saved edits become operator-owned. Regenerating another section preserves your saved changes.",
        )}
      </p>
      {!sections.length && (
        <p>
          {t(
            "採納建議後即可編輯已建立的段落。",
            "Adopt a proposal to edit its established sections.",
          )}
        </p>
      )}
      {draft.map((section) => (
        <fieldset
          className="field-group"
          key={section.key}
          disabled={!storageReady || !canEdit || busy || saving}
        >
          <legend>
            {t(
              wineSectionLabels[section.key][0],
              wineSectionLabels[section.key][1],
            )}
          </legend>
          <div className="field-grid">
            {(["en", "zh-Hant"] as const).map((lang) => (
              <label key={lang} className="field-control">
                {t(
                  wineSectionLabels[section.key][0],
                  wineSectionLabels[section.key][1],
                )}{" "}
                · {lang === "en" ? "English" : "繁體中文"}
                <textarea
                  lang={lang}
                  rows={4}
                  maxLength={20000}
                  value={section[lang]}
                  onChange={(event) => {
                    const value = event.target.value;
                    setDraft((items) =>
                      items.map((s) =>
                        s.key === section.key ? { ...s, [lang]: value } : s,
                      ),
                    );
                  }}
                />
              </label>
            ))}
          </div>
          <label>
            <input
              type="checkbox"
              checked={section.locked}
              onChange={(event) => {
                const locked = event.target.checked;
                setDraft((items) =>
                  items.map((s) =>
                    s.key === section.key ? { ...s, locked } : s,
                  ),
                );
              }}
            />
            {t("鎖定段落", "Lock section")}
          </label>
          <p>
            {section.owner === "operator"
              ? t("由操作員管理", "Operator-owned")
              : t("自動建立", "Automatically generated")}
          </p>
          <button
            className="secondary-button"
            type="button"
            data-regenerate={section.key}
            disabled={dirty || section.locked || section.owner === "operator"}
            onClick={() => onRegenerate(section.key)}
          >
            {t(
              "重新生成此段落（不搜尋）",
              "Regenerate this section (no search)",
            )}
          </button>
        </fieldset>
      ))}
      {dirty && (
        <p role="status">
          {t(
            "有未儲存修改。請先儲存再重新生成。",
            "Unsaved edits. Save before regenerating.",
          )}
        </p>
      )}
      {error && (
        <p role="alert">
          {t(
            "儲存失敗，修改仍然保留。若版本有變，請核對最新資料後再嘗試。",
            "Save failed; your edits are retained. If the version changed, compare the latest data before retrying.",
          )}
        </p>
      )}
      <button
        className="secondary-button"
        type="button"
        data-action="save-sections"
        disabled={!storageReady || !dirty || !canEdit || busy || saving}
        onClick={save}
      >
        {t("儲存段落", "Save sections")}
      </button>
      {dirty && (
        <button
          className="secondary-button"
          type="button"
          disabled={!storageReady || busy || saving}
          onClick={() => {
            if (!storageReady || busy || saving) return;
            if (
              window.confirm(
                t("放棄未儲存的段落修改？", "Discard unsaved paragraph edits?"),
              )
            ) {
              if (draftKey && !writeWineSectionDraft(draftKey, null))
                setStorageError(true);
              setRecovered(false);
              setBase({ sections, revision, baseVersionId });
              setDraft(sections);
              setError(false);
            }
          }}
        >
          {t("放棄修改並載入最新資料", "Discard edits and load latest")}
        </button>
      )}
    </section>
  );
}
