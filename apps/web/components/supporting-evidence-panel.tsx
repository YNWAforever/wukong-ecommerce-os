"use client";

import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";

export function SupportingEvidencePanel() {
  const locale = useLocale();
  return (
    <div className="intake-form">
      <h2>{localized(locale, "補充證據", "Supporting evidence")}</h2>
      <p>
        {localized(
          locale,
          "此功能在本試點階段尚未提供。此頁面不會接受或儲存任何檔案。",
          "This capability is not yet available in this pilot. This page does not accept or store any file.",
        )}
      </p>
    </div>
  );
}
