"use client";

import { useState } from "react";

import { AdminConnectionPanel } from "./admin-connection-panel";
import { AdminMembersPanel } from "./admin-members-panel";
import { AdminSettingsPanel } from "./admin-settings-panel";

type AdminTab = "members" | "connection" | "settings";

const TABS: { id: AdminTab; label: string }[] = [
  { id: "members", label: "成員 Members" },
  { id: "connection", label: "SHOPLINE 連線 Connection" },
  { id: "settings", label: "設定 Settings" },
];

export function AdminTabs() {
  const [active, setActive] = useState<AdminTab>("members");

  return (
    <div className="admin-tabs">
      <div className="admin-tab-list" role="tablist" aria-label="管理區段">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            id={`admin-tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={active === tab.id}
            aria-controls="admin-tab-panel"
            className={active === tab.id ? "admin-tab active" : "admin-tab"}
            onClick={() => setActive(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div
        id="admin-tab-panel"
        className="admin-tab-panel"
        role="tabpanel"
        aria-labelledby={`admin-tab-${active}`}
      >
        {active === "members" ? <AdminMembersPanel /> : null}
        {active === "connection" ? <AdminConnectionPanel /> : null}
        {active === "settings" ? <AdminSettingsPanel /> : null}
      </div>
    </div>
  );
}
