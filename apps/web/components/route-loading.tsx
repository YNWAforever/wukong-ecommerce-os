"use client";
import { useLocale } from "../lib/locale-context";
import { commonCopy } from "../lib/ui-copy";
export function RouteLoading() {
  const locale = useLocale();
  return (
    <p className="helper-copy" role="status">
      {commonCopy[locale].loading}
    </p>
  );
}
