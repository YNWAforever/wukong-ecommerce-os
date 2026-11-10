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
    "管理工作區的 MCP 權杖、外部 MCP 連線登錄與工具目錄。唯一的對外呼叫是管理員明確探測已登錄端點。",
    "Manage workspace MCP tokens, the external MCP connection registry and the tool catalogue. The only outbound call is an explicit admin probe of a registered endpoint.",
  ],
  "studio.settings.adminOnly": [
    "只有工作區管理員可以開啟工作室設定。",
    "Only a workspace administrator can open Studio settings.",
  ],
  "studio.settings.noLiveConnection": [
    "沒有即時連線指標：除非管理員明確探測已登錄端點，否則不會呼叫任何伺服器。",
    "No live connection indicator: the page never calls a server unless an admin explicitly probes a registered endpoint.",
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
  "studio.settings.tokens.quotas": ["配額", "Quotas"],
  "studio.settings.tokens.quotaRate": [
    "每分鐘呼叫上限（1–600）",
    "Calls per minute (1–600)",
  ],
  "studio.settings.tokens.quotaMonthly": [
    "每月呼叫上限（1–1,000,000）",
    "Monthly calls (1–1,000,000)",
  ],
  "studio.settings.tokens.quotaUnlimited": ["無限制", "Unlimited"],
  "studio.settings.tokens.quotaHint": [
    "留空表示無限制。每分鐘上限以 60 秒滾動窗口計算；每月上限以 UTC 月份計算。",
    "Leave blank for unlimited. The per-minute limit uses a rolling 60-second window; the monthly quota uses the UTC calendar month.",
  ],
  "studio.settings.tokens.quotaInvalid": [
    "配額必須是範圍內的整數，或留空表示無限制。",
    "A quota must be an integer within range, or blank for unlimited.",
  ],
  "studio.settings.tokens.usage": ["用量", "Usage"],
  "studio.settings.tokens.usageMinute": ["每分鐘", "per minute"],
  "studio.settings.tokens.usageMonth": ["每月", "per month"],
  "studio.settings.tokens.editLimits": ["編輯配額", "Edit limits"],
  "studio.settings.tokens.saveLimits": ["儲存配額", "Save limits"],
  "studio.settings.tokens.savingLimits": ["正在儲存…", "Saving…"],
  "studio.settings.tokens.cancel": ["取消", "Cancel"],
  "studio.settings.tokens.limitsSaved": [
    "配額已更新（以伺服器回讀為準）。",
    "Limits updated from the server readback.",
  ],
  "studio.settings.tokens.limitsError": [
    "未能更新配額，請重試。",
    "The limits could not be updated. Try again.",
  ],
  "studio.settings.tokens.rotate": ["輪替", "Rotate"],
  "studio.settings.tokens.rotating": ["正在輪替…", "Rotating…"],
  "studio.settings.tokens.rotateConfirm": [
    "輪替會立即撤銷舊權杖，並只顯示新權杖一次。要繼續嗎？",
    "Rotation revokes the old token immediately and shows the new one once. Continue?",
  ],
  "studio.settings.tokens.rotateConfirmAction": ["確認輪替", "Confirm rotate"],
  "studio.settings.tokens.rotateError": [
    "未能輪替權杖，請重試。",
    "The token could not be rotated. Try again.",
  ],
  "studio.settings.tokens.revokeError": [
    "未能撤銷權杖，請重試。",
    "The token could not be revoked. Try again.",
  ],

  // -- external MCP connections --------------------------------------------
  "studio.settings.external.title": [
    "外部 MCP 連線",
    "External MCP connections",
  ],
  "studio.settings.external.lede": [
    "登錄經管理員核准的外部伺服器與工具允許清單；只有明確的探測操作才會連線端點。",
    "Records admin-approved external servers and tool allowlists; only an explicit probe contacts an endpoint.",
  ],
  "studio.settings.external.disabledBanner": [
    "外部 MCP 預設停用。此頁只管理登錄資料；僅在按下探測時才會連線端點，且旗標、工作區與金鑰必須全部就緒。",
    "External MCP is disabled by default. This page manages registry records; it only contacts an endpoint when you explicitly probe, and only with the flag, workspace and key all in place.",
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
  "studio.settings.external.credential": [
    "工作區憑證（Bearer，加密儲存）",
    "Workspace credential (bearer, stored encrypted)",
  ],
  "studio.settings.external.credentialPlaceholder": [
    "貼上權杖；儲存後不會再顯示",
    "Paste a token; it is never shown again",
  ],
  "studio.settings.external.saveCredential": ["儲存憑證", "Save credential"],
  "studio.settings.external.savingCredential": ["正在儲存…", "Saving…"],
  "studio.settings.external.clearCredential": ["清除憑證", "Clear credential"],
  "studio.settings.external.clearingCredential": ["正在清除…", "Clearing…"],
  "studio.settings.external.credentialPresent": [
    "已儲存憑證",
    "Credential stored",
  ],
  "studio.settings.external.credentialAbsent": [
    "未儲存憑證",
    "No credential stored",
  ],
  "studio.settings.external.credentialSaved": [
    "憑證已加密儲存；核准世代已重設。",
    "Credential stored encrypted; the approval generation was reset.",
  ],
  "studio.settings.external.credentialRequired": [
    "請輸入憑證。",
    "Enter a credential.",
  ],
  "studio.settings.external.credentialCleared": [
    "憑證已清除。",
    "Credential cleared.",
  ],
  "studio.settings.external.probe": ["探測端點", "Probe endpoint"],
  "studio.settings.external.probing": ["正在探測…", "Probing…"],
  "studio.settings.external.probeHint": [
    "只呼叫 initialize 與 tools/list，不會呼叫任何工具。",
    "Calls initialize and tools/list only; no tool is invoked.",
  ],
  "studio.settings.external.probeBlocked": [
    "探測需要部署旗標、工作區與加密金鑰全部就緒。",
    "Probing needs the deployment flag, workspace and encryption key all in place.",
  ],
  "studio.settings.external.probeTitle": ["探測結果", "Probe result"],
  "studio.settings.external.probeAdvertised": ["公告雜湊", "Advertised"],
  "studio.settings.external.probePinned": ["已釘選", "Pinned"],
  "studio.settings.external.probeNotPinned": ["未釘選", "Not pinned"],
  "studio.settings.external.probeMissingTools": [
    "缺少的允許清單工具：",
    "Missing allowlisted tools:",
  ],
  "studio.settings.external.pinAdvertised": [
    "釘選公告雜湊",
    "Pin advertised hashes",
  ],
  "studio.settings.external.pinning": ["正在釘選…", "Pinning…"],
  "studio.settings.external.pinnedDone": [
    "已釘選公告雜湊；核准世代已重設。",
    "Advertised hashes pinned; the approval generation was reset.",
  ],
  "studio.settings.external.probeError": [
    "探測未完成，請檢查端點與憑證。",
    "The probe did not complete. Check the endpoint and credential.",
  ],
  "studio.settings.external.probeStatus.ok": ["結構相符", "Schema matches"],
  "studio.settings.external.probeStatus.schema_drift": [
    "結構已變動",
    "Schema drifted",
  ],
  "studio.settings.external.probeStatus.denied": [
    "允許清單工具未提供",
    "Allowlisted tool missing",
  ],
  "studio.settings.external.probeStatus.unavailable": [
    "端點無法使用",
    "Endpoint unavailable",
  ],
  "studio.settings.external.probeStatus.timeout": [
    "端點逾時",
    "Endpoint timed out",
  ],

  // -- editable workspace settings (A1) -------------------------------------
  "studio.settings.workspace.formTitle": ["工作區設定", "Workspace settings"],
  "studio.settings.workspace.roleNote": [
    "只有管理員或擁有者可以變更工作區設定；儲存後以伺服器回讀值為準。",
    "Only an admin or owner can change workspace settings; saved values are read back from the server.",
  ],
  "studio.settings.workspace.enableToggle": ["啟用工作室", "Enable Studio"],
  "studio.settings.workspace.enableHint": [
    "亦須部署旗標 CONVERSATION_STUDIO_ENABLED 為 true，工作區成員才會看到工作室。",
    "The deployment flag CONVERSATION_STUDIO_ENABLED must also be true before members see Studio.",
  ],
  "studio.settings.workspace.allowedSkillsHint": [
    "未選取任何技能即代表全部已試行技能；未知或未試行技能不能儲存。",
    "No selection means every pilot skill; unknown or non-pilot skills cannot be saved.",
  ],
  "studio.settings.workspace.monthlyBudgetHint": [
    "0 至 100 美元，最多 6 位小數；留空表示未設定。",
    "0 to 100 USD, up to 6 decimals; blank means not set.",
  ],
  "studio.settings.workspace.runCeilingHint": [
    "不得高於月度預算；留空表示未設定。",
    "May not exceed the monthly budget; blank means not set.",
  ],
  "studio.settings.workspace.retentionHint": [
    "1 至 365 天；留空表示未設定保留政策（目前只儲存，尚未強制執行）。",
    "1 to 365 days; blank means no retention policy (stored only; not enforced yet).",
  ],
  "studio.settings.workspace.defaultHomeHint": [
    "僅在部署旗標與工作區皆啟用時生效。",
    "Only applies when both the deployment flag and the workspace row are enabled.",
  ],
  "studio.settings.workspace.readinessTitle": ["就緒狀態", "Readiness"],
  "studio.settings.workspace.deploymentFlag": ["部署旗標", "Deployment flag"],
  "studio.settings.workspace.effectiveEnabled": [
    "工作區可見",
    "Visible in workspace",
  ],
  "studio.settings.workspace.modelConfiguredLabel": ["即時模型", "Live model"],
  "studio.settings.workspace.budgetsPresent": [
    "預算與上限",
    "Budget and ceiling",
  ],
  "studio.settings.workspace.on": ["開", "On"],
  "studio.settings.workspace.off": ["關", "Off"],
  "studio.settings.workspace.aiTitle": [
    "即時模型（選填）",
    "Live model (optional)",
  ],
  "studio.settings.workspace.aiHint": [
    "留空即維持純規則模式：不會呼叫模型，也不會預留預算。",
    "Leave empty to stay deterministic-only: no model call and no budget hold.",
  ],
  "studio.settings.workspace.aiDeterministic": [
    "不使用即時模型（純規則模式）",
    "No live model (deterministic only)",
  ],
  "studio.settings.workspace.aiProvider": ["供應商", "Provider"],
  "studio.settings.workspace.aiModel": ["模型", "Model"],
  "studio.settings.workspace.aiNoReviewedModels": [
    "此供應商目前沒有已審核模型，無法儲存即時模型設定。",
    "No reviewed model exists for this provider yet, so live-model settings cannot be saved.",
  ],
  "studio.settings.workspace.aiPricingVersion": ["定價版本", "Pricing version"],
  "studio.settings.workspace.aiMaxInputTokens": [
    "最大輸入 Token",
    "Max input tokens",
  ],
  "studio.settings.workspace.aiInputPrice": [
    "輸入價格（每百萬 Token 美元）",
    "Input price (USD per million tokens)",
  ],
  "studio.settings.workspace.aiOutputPrice": [
    "輸出價格（每百萬 Token 美元）",
    "Output price (USD per million tokens)",
  ],
  "studio.settings.workspace.aiMaxOutputTokens": [
    "最大輸出 Token",
    "Max output tokens",
  ],
  "studio.settings.workspace.aiReviewHint": [
    "模型與價格下限來自已審核成本登記冊；低於下限、未知模型或超出模型 Token 上限的設定會被拒絕。",
    "Model and price floors come from the reviewed cost registry; below-floor prices, unknown models or token contexts above the model maximum are rejected.",
  ],
  "studio.settings.workspace.invalidNumber": [
    "請輸入有效的數字（預算最多 6 位小數、價格最多 4 位小數）。",
    "Enter a valid number (up to 6 decimals for budgets and 4 for prices).",
  ],
  "studio.settings.workspace.save": ["儲存設定", "Save settings"],
  "studio.settings.workspace.saving": ["正在儲存…", "Saving…"],
  "studio.settings.workspace.saved": [
    "已儲存；以下數值為伺服器回讀結果。",
    "Saved; the values below are read back from the server.",
  ],
  "studio.settings.workspace.saveError": [
    "設定未能儲存；請檢查欄位後重試。",
    "Settings were not saved; check the fields and try again.",
  ],

  // -- tool catalogue -------------------------------------------------------
  "studio.settings.tools.title": [
    "工具目錄（唯讀）",
    "Tool catalogue (read-only)",
  ],
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
