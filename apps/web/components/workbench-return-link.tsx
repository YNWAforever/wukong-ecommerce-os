"use client";
import Link from "next/link";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import { normalizeWorkbenchReturn } from "../lib/workbench-navigation";
export function WorkbenchReturnLink({ returnTo }: { returnTo: string }) {
  const locale = useLocale();
  return (
    <Link className="jobs-row-link" href={normalizeWorkbenchReturn(returnTo)}>
      {localized(locale, "返回工作台", "Return to workbench")}
    </Link>
  );
}
