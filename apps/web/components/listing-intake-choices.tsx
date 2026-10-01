"use client";
import Link from "next/link";
import { useState } from "react";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import type { MaintenanceIntent } from "../lib/catalog-maintenance-intent";
import { BulkImportPanel } from "./bulk-import-panel";
import { ListingIntakeTabs } from "./listing-intake-tabs";

export type MaintenanceReference = { kind: "workbook" | "website"; id: string };
export function ListingIntakeChoices({
  canScan,
  initialIntent = "maintain-existing",
  reference,
  invalidReference = false,
}: {
  canScan: boolean;
  initialIntent?: Exclude<MaintenanceIntent, "new-draft">;
  reference?: MaintenanceReference;
  invalidReference?: boolean;
}) {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const [intent, setIntent] = useState(initialIntent);
  const [visited, setVisited] = useState(new Set([initialIntent]));
  function select(next: typeof intent) {
    setIntent(next);
    setVisited((previous) => new Set([...previous, next]));
    const url = new URL(window.location.href);
    url.searchParams.set("intent", next);
    window.history.replaceState(null, "", url);
  }
  return (
    <section aria-label={t("商品工作目的", "Product task")}>
      <nav
        className="admin-tab-list"
        aria-label={t("選擇工作目的", "Choose a task")}
      >
        <button
          type="button"
          className={
            intent === "maintain-existing" ? "admin-tab active" : "admin-tab"
          }
          aria-pressed={intent === "maintain-existing"}
          onClick={() => select("maintain-existing")}
        >
          {t("維護既有 SHOPLINE 商品", "Maintain existing SHOPLINE products")}
        </button>
        <button
          type="button"
          className={
            intent === "reference-only" ? "admin-tab active" : "admin-tab"
          }
          aria-pressed={intent === "reference-only"}
          onClick={() => select("reference-only")}
        >
          {t("只建立參考資料", "Reference only")}
        </button>
        {canScan ? (
          <Link className="admin-tab" href="/listings/new">
            {t("建立新草稿", "Create new draft")}
          </Link>
        ) : null}
      </nav>
      <div hidden={intent !== "maintain-existing"}>
        {visited.has("maintain-existing") ? (
          invalidReference ? (
            <p role="alert">
              {t(
                "參考資料連結無效，請返回商品中心重新選擇。",
                "The reference link is invalid. Return to the catalog and select it again.",
              )}
            </p>
          ) : (
            <BulkImportPanel reference={reference} />
          )
        ) : null}
      </div>
      <div hidden={intent !== "reference-only"}>
        {visited.has("reference-only") ? (
          <>
            <p>
              {t(
                "網站及試算表資料僅供參考。維護商品須另行核對商店，並上載目前的原始 SHOPLINE 匯出檔。",
                "Website and workbook records are reference only. Maintenance requires a checked store and its current original SHOPLINE export.",
              )}
            </p>
            <ListingIntakeTabs canScan={canScan} referenceOnly />
          </>
        ) : null}
      </div>
    </section>
  );
}
