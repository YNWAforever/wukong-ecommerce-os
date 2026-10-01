"use client";
import { useState } from "react";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import { supportRequestId } from "../lib/support-request-id";

export function SupportRequestId({ value }: { value?: unknown }) {
  const locale = useLocale();
  const [copied, setCopied] = useState(false);
  const id = supportRequestId(value);
  if (!id) return null;
  return (
    <span className="helper-copy">
      {localized(locale, "支援編號", "Support ID")}: <code>{id}</code>{" "}
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(id)
            .then(() => setCopied(true))
            .catch(() => {});
        }}
      >
        {localized(
          locale,
          copied ? "已複製" : "複製編號",
          copied ? "Copied" : "Copy ID",
        )}
      </button>
    </span>
  );
}
