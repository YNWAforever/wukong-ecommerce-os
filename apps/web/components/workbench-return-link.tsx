"use client";
import Link from "next/link";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import { normalizeWorkbenchReturn } from "../lib/workbench-navigation";
export function WorkbenchReturnLink({ returnTo }: { returnTo: string }) {
  const locale = useLocale();
  const href = normalizeWorkbenchReturn(returnTo);
  return (
    <Link className="jobs-row-link" href={href}>
      {href.startsWith("/catalog")
        ? localized(locale, "返回商品中心", "Return to catalog")
        : href.startsWith("/jobs")
          ? localized(locale, "返回作業", "Return to jobs")
          : localized(locale, "返回工作台", "Return to workbench")}
    </Link>
  );
}
