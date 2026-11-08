import type { Locale } from "./locale";
import { localized, type BilingualMessage } from "./ui-copy";

/**
 * Copy for the admin-only Studio settings surface (plan Task 13).
 *
 * Kept in its own module because another session owns `studio-copy.ts`
 * concurrently. The same rules apply: bilingual tuples, honest wording, no
 * marketing claims, and every string the settings page/panels render comes
 * from here rather than being hardcoded per component.
 */
export const STUDIO_SETTINGS_COPY = {
  // -- page -----------------------------------------------------------------
  "studio.settings.eyebrow": ["工作室管理", "STUDIO ADMIN"],
  "studio.settings.title": ["工作室設定", "Studio settings"],
  "studio.settings.lede": [
    "管理工作區的 MCP 權杖、外部 MCP 連線登錄與工具目錄。此頁不會對外連線。",
    "Manage workspace MCP tokens, the external MCP connection registry and the tool catalogue. This page makes no outbound connection.",
  ],
  "studio.settings.adminOnly": [
    "只有工作區管理員可以開啟工作室設定。",
    "Only a workspace administrator can open Studio settings.",
  ],
  "studio.settings.noLiveConnection": [
    "沒有即時連線指標：此頁不會測試、呼叫或連線任何外部伺服器。",
    "No live connection indicator: this page never tests, calls or connects to an external server.",
  ],

  // -- workspace state ------------------------------------------------------
  "studio.settings.workspace.title": [
    "工作區工作室狀態",
    "Workspace Studio state",
  ],
  "studio.settings.workspace.lede": [
    "唯讀顯示目前工作區的設定；變更須由工作區管理員在其他受審核的流程處理。",
    "Read-only view of this workspace's settings; changes happen through the separately reviewed admin flow.",
  ],
  "studio.settings.workspace.enabled": ["已啟用", "Enabled"],
  "studio.settings.workspace.disabled": ["未啟用", "Disabled"],
  "studio.settings.workspace.budget": [
    "月度模型預算（美元）",
    "Monthly model budget (USD)",
  ],
  "studio.settings.workspace.runCeiling": [
    "單次執行上限（美元）",
    "Per-run ceiling (USD)",
  ],
  "studio.settings.workspace.retention": ["保留天數", "Retention days"],
  "studio.settings.workspace.defaultHome": [
    "登入後預設頁",
    "Default home after sign-in",
  ],
  "studio.settings.workspace.allowedSkills": ["允許的技能", "Allowed skills"],
  "studio.settings.workspace.allSkills": [
    "所有已審核技能",
    "All reviewed skills",
  ],
  "studio.settings.workspace.aiConfigured": [
    "已設定即時模型",
    "Live model configured",
  ],
  "studio.settings.workspace.aiNotConfigured": [
    "未設定即時模型",
    "Live model not configured",
  ],
  "studio.settings.workspace.notSet": ["未設定", "Not set"],
  "studio.settings.workspace.yes": ["是", "Yes"],
  "studio.settings.workspace.no": ["否", "No"],
  "studio.settings.workspace.budgetNote": [
    "預算只用於明確送出的模型回合；讀取與概況不會預留預算。",
    "Budget applies only to explicit model turns; reads and the overview never reserve it.",
  ],

  // -- API tokens -----------------------------------------------------------
  "studio.settings.tokens.title": ["API 權杖", "API tokens"],
  "studio.settings.tokens.lede": [
    "工作區範圍權杖，供 MCP 用戶端呼叫已審核的讀取與建議工具；派送工具不在 MCP 暴露。",
    "Workspace-scoped tokens for MCP clients to call reviewed read and propose tools; dispatch tools are not exposed over MCP.",
  ],
  "studio.settings.tokens.empty": ["尚未建立權杖。", "No tokens yet."],
  "studio.settings.tokens.label": ["名稱", "Label"],
  "studio.settings.tokens.scopes": ["範圍", "Scopes"],
  "studio.settings.tokens.scope.read": ["讀取", "Read"],
  "studio.settings.tokens.scope.propose": ["建議", "Propose"],
  "studio.settings.tokens.create": ["建立權杖", "Create token"],
  "studio.settings.tokens.creating": ["正在建立…", "Creating…"],
  "studio.settings.tokens.plaintextOnce": [
    "請立即複製權杖；關閉後無法再次查看。",
    "Copy the token now; it cannot be shown again after you leave.",
  ],
  "studio.settings.tokens.copy": ["複製", "Copy"],
  "studio.settings.tokens.copied": ["已複製", "Copied"],
  "studio.settings.tokens.revoke": ["撤銷", "Revoke"],
  "studio.settings.tokens.revoking": ["正在撤銷…", "Revoking…"],
  "studio.settings.tokens.revoked": ["已撤銷", "Revoked"],
  "studio.settings.tokens.active": ["有效", "Active"],
  "studio.settings.tokens.prefix": ["前綴", "Prefix"],
  "studio.settings.tokens.lastUsed": ["最近使用", "Last used"],
  "studio.settings.tokens.neverUsed": ["從未使用", "Never used"],
  "studio.settings.tokens.created": ["建立時間", "Created"],
  "studio.settings.tokens.labelRequired": [
    "請輸入權杖名稱。",
    "Enter a token label.",
  ],
  "studio.settings.tokens.actionError": [
    "操作未能完成，請重試。",
    "The action did not complete. Try again.",
  ],
  "studio.settings.tokens.adminRequired": [
    "需要管理員權限。",
    "Administrator access is required.",
  ],

  // -- external MCP connections --------------------------------------------
  "studio.settings.external.title": [
    "外部 MCP 連線",
    "External MCP connections",
  ],
  "studio.settings.external.lede": [
    "登錄經管理員核准的外部伺服器與工具允許清單；即使已核准，外部傳輸仍須部署旗標開啟。",
    "Records admin-approved external servers and tool allowlists; even when approved, external transport still needs the deployment flag.",
  ],
  "studio.settings.external.disabledBanner": [
    "外部 MCP 預設停用。此頁只管理登錄資料，不會對外連線或探測端點。",
    "External MCP is disabled by default. This page only manages registry records and never connects to or probes an endpoint.",
  ],
  "studio.settings.external.flagOff": [
    "部署旗標 STUDIO_EXTERNAL_MCP_ENABLED 未開啟，因此無法核准連線。",
    "The deployment flag STUDIO_EXTERNAL_MCP_ENABLED is off, so connections cannot be approved.",
  ],
  "studio.settings.external.keyMissing": [
    "未設定加密金鑰 STUDIO_MCP_ENCRYPTION_KEY，因此無法核准連線。",
    "The encryption key STUDIO_MCP_ENCRYPTION_KEY is not configured, so connections cannot be approved.",
  ],
  "studio.settings.external.approveBlocked": [
    "在旗標、工作區與加密金鑰就緒前無法核准。",
    "Approval is unavailable until the flag, workspace and encryption key are in place.",
  ],
  "studio.settings.external.empty": [
    "尚未登錄外部連線。",
    "No external connections are registered.",
  ],
  "studio.settings.external.create": [
    "建立草稿連線",
    "Create draft connection",
  ],
  "studio.settings.external.creating": ["正在建立…", "Creating…"],
  "studio.settings.external.label": ["名稱", "Label"],
  "studio.settings.external.endpoint": ["HTTPS 端點", "HTTPS endpoint"],
  "studio.settings.external.transport": ["傳輸", "Transport"],
  "studio.settings.external.allowlist": [
    "工具允許清單（每行一個）",
    "Tool allowlist (one per line)",
  ],
  "studio.settings.external.schemaHashes": [
    "結構雜湊（JSON：工具名稱 → sha256）",
    "Schema hashes (JSON: tool name → sha256)",
  ],
  "studio.settings.external.approve": ["核准", "Approve"],
  "studio.settings.external.approving": ["正在核准…", "Approving…"],
  "studio.settings.external.disable": ["停用", "Disable"],
  "studio.settings.external.disabling": ["正在停用…", "Disabling…"],
  "studio.settings.external.status.draft": ["草稿", "Draft"],
  "studio.settings.external.status.approved": ["已核准", "Approved"],
  "studio.settings.external.status.disabled": ["已停用", "Disabled"],
  "studio.settings.external.tools": ["工具", "Tools"],
  "studio.settings.external.generation": ["世代", "Generation"],
  "studio.settings.external.approvedBy": ["核准者", "Approved by"],
  "studio.settings.external.created": ["已建立草稿。", "Draft created."],
  "studio.settings.external.approved": [
    "連線已核准；外部傳輸仍受部署旗標控制。",
    "Connection approved; external transport is still controlled by the deployment flag.",
  ],
  "studio.settings.external.disabledDone": [
    "連線已停用。",
    "Connection disabled.",
  ],
  "studio.settings.external.actionError": [
    "操作未能完成，請重試。",
    "The action did not complete. Try again.",
  ],
  "studio.settings.external.invalidEndpoint": [
    "請輸入不含憑證的 HTTPS 端點。",
    "Enter an HTTPS endpoint without credentials.",
  ],
  "studio.settings.external.allowlistRequired": [
    "請至少輸入一個工具名稱。",
    "Enter at least one tool name.",
  ],
  "studio.settings.external.schemaHashesInvalid": [
    "結構雜湊必須是 JSON，將工具名稱對應到 64 位十六進位雜湊。",
    "Schema hashes must be JSON mapping tool names to 64-character hex hashes.",
  ],
  "studio.settings.external.labelRequired": [
    "請輸入連線名稱。",
    "Enter a connection label.",
  ],

  // -- tool catalogue -------------------------------------------------------
  "studio.settings.tools.title": ["工具目錄（唯讀）", "Tool catalogue (read-only)"],
  "studio.settings.tools.lede": [
    "已審核的內部工具清單；派送工具不會透過 MCP 暴露。",
    "The reviewed internal tool list; dispatch tools are not exposed over MCP.",
  ],
  "studio.settings.tools.name": ["工具", "Tool"],
  "studio.settings.tools.kind": ["類型", "Kind"],
  "studio.settings.tools.minRole": ["最低角色", "Minimum role"],
  "studio.settings.tools.cost": ["成本類別", "Cost class"],
  "studio.settings.tools.kind.read": ["讀取", "Read"],
  "studio.settings.tools.kind.propose": ["建議", "Propose"],
  "studio.settings.tools.kind.dispatch": ["派送", "Dispatch"],
  "studio.settings.tools.cost.free": ["免費", "Free"],
  "studio.settings.tools.cost.model": ["模型", "Model"],
  "studio.settings.tools.cost.paid": ["付費", "Paid"],
} as const satisfies Record<string, BilingualMessage>;

/** Every key in `STUDIO_SETTINGS_COPY`, for typed consumption. */
export type StudioSettingsCopyKey = keyof typeof STUDIO_SETTINGS_COPY;

/** The only supported reader; a missing key is a compile error. */
export function studioSettingsCopy(
  locale: Locale,
  key: StudioSettingsCopyKey,
): string {
  const message = STUDIO_SETTINGS_COPY[key];
  return localized(locale, message[0], message[1]);
}

/** Keys whose zh-Hant or en value is empty/missing after trimming. */
export function studioSettingsCopyParity(): StudioSettingsCopyKey[] {
  const keys = Object.keys(STUDIO_SETTINGS_COPY) as StudioSettingsCopyKey[];
  return keys.filter((key) => {
    const [zh, en] = STUDIO_SETTINGS_COPY[key];
    return zh.trim().length === 0 || en.trim().length === 0;
  });
}
