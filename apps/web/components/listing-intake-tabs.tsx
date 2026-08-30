"use client";

import { useState } from "react";

import { BulkImportPanel } from "./bulk-import-panel";
import { NewProductBlockedPanel } from "./new-product-blocked-panel";
import { SupportingEvidencePanel } from "./supporting-evidence-panel";

type IntakeTab = "bulk" | "evidence" | "create";

const TABS: { id: IntakeTab; label: string }[] = [
  { id: "bulk", label: "現有商品 Existing products" },
  { id: "evidence", label: "補充證據 Supporting evidence" },
  { id: "create", label: "新商品 New products" },
];

export function ListingIntakeTabs() {
  const [active, setActive] = useState<IntakeTab>("bulk");

  return (
    <div className="admin-tabs">
      <div className="admin-tab-list" role="tablist" aria-label="商品匯入區段">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            id={`intake-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            aria-controls="intake-tab-panel"
            className={active === tab.id ? "admin-tab active" : "admin-tab"}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id="intake-tab-panel"
        className="admin-tab-panel"
        role="tabpanel"
        aria-labelledby={`intake-tab-${active}`}
      >
        {active === "bulk" ? <BulkImportPanel /> : null}
        {active === "evidence" ? <SupportingEvidencePanel /> : null}
        {active === "create" ? <NewProductBlockedPanel /> : null}
      </div>
    </div>
  );
}
