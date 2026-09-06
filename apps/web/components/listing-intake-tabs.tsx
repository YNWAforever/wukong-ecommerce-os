"use client";
import { useState } from "react";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import { BulkImportPanel } from "./bulk-import-panel";
import { NewProductBlockedPanel } from "./new-product-blocked-panel";
import { SupportingEvidencePanel } from "./supporting-evidence-panel";
import { WebsiteImportPanel } from "./website-import-panel";
type IntakeTab = "website" | "bulk" | "evidence" | "create";
export function ListingIntakeTabs({ canScan = true }: { canScan?: boolean }) {
  const locale = useLocale();
  const [active, setActive] = useState<IntakeTab>("website");
  const [workbookVisited, setWorkbookVisited] = useState(false);
  const tabs: { id: IntakeTab; label: string }[] = [
    { id: "website", label: localized(locale, "網站", "Website") },
    { id: "bulk", label: localized(locale, "試算表", "Workbook") },
    {
      id: "evidence",
      label: localized(locale, "補充證據", "Supporting evidence"),
    },
    { id: "create", label: localized(locale, "新商品", "New products") },
  ];
  function select(id: IntakeTab) {
    setActive(id);
    if (id === "bulk") setWorkbookVisited(true);
  }
  return (
    <div className="admin-tabs">
      <div
        className="admin-tab-list"
        role="tablist"
        aria-label={localized(locale, "商品匯入區段", "Catalog import choices")}
      >
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            id={`intake-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            aria-controls={`intake-panel-${tab.id}`}
            tabIndex={active === tab.id ? 0 : -1}
            className={active === tab.id ? "admin-tab active" : "admin-tab"}
            onClick={() => select(tab.id)}
            onKeyDown={(event) => {
              const next =
                event.key === "ArrowRight"
                  ? (index + 1) % tabs.length
                  : event.key === "ArrowLeft"
                    ? (index + tabs.length - 1) % tabs.length
                    : event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? tabs.length - 1
                        : null;
              if (next !== null) {
                event.preventDefault();
                const id = tabs[next]!.id;
                select(id);
                document.getElementById(`intake-tab-${id}`)?.focus();
              }
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {tabs.map((tab) => (
        <div
          key={tab.id}
          id={`intake-panel-${tab.id}`}
          className="admin-tab-panel"
          role="tabpanel"
          aria-labelledby={`intake-tab-${tab.id}`}
          hidden={active !== tab.id}
        >
          {tab.id === "website" && active === "website" ? (
            <WebsiteImportPanel canScan={canScan} />
          ) : null}
          {tab.id === "bulk" && workbookVisited ? <BulkImportPanel /> : null}
          {tab.id === "evidence" && active === "evidence" ? (
            <SupportingEvidencePanel />
          ) : null}
          {tab.id === "create" && active === "create" ? (
            <NewProductBlockedPanel />
          ) : null}
        </div>
      ))}
    </div>
  );
}
