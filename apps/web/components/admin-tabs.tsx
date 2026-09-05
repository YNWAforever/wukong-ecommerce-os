"use client";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";

import { useState } from "react";

import { AdminConnectionPanel } from "./admin-connection-panel";
import { AdminMembersPanel } from "./admin-members-panel";
import { AdminSettingsPanel } from "./admin-settings-panel";
import { CapabilityRegistryPanel } from "./capability-registry-panel";

type AdminTab = "members" | "connection" | "settings" | "capabilities";

const TABS: { id: AdminTab; label: string }[] = [
  { id: "members", label: "成員 Members" },
  { id: "connection", label: "SHOPLINE 連線 Connection" },
  { id: "settings", label: "設定 Settings" },
  { id: "capabilities", label: "系統真相 Capabilities" },
];

export function AdminTabs() {
  const locale = useLocale();
  const [active, setActive] = useState<AdminTab>("members");

  return (
    <div className="admin-tabs">
      <div
        className="admin-tab-list"
        role="tablist"
        aria-label={localized(locale, "管理區段", "Admin sections")}
      >
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
            {localized(
              locale,
              {
                members: "成員",
                connection: "SHOPLINE 連線",
                settings: "設定",
                capabilities: "系統真相",
              }[tab.id],
              {
                members: "Members",
                connection: "SHOPLINE connection",
                settings: "Settings",
                capabilities: "System Truth",
              }[tab.id],
            )}
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
        {active === "capabilities" ? <CapabilityRegistryPanel /> : null}
      </div>
    </div>
  );
}
