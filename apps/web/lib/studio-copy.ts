import type { Locale } from "./locale";
import { localized, type BilingualMessage } from "./ui-copy";

/**
 * Every Conversation Studio string, as `[zh-Hant, en]` tuples.
 *
 * Rules this file exists to keep:
 *  - one place, two languages, no `next-intl` (see the design spec's global
 *    constraints); `studioCopy(locale, key)` is the only reader;
 *  - honest phrasing only. The copy describes what this build actually does:
 *    a static shell with disabled actions, not a shipped assistant. It never
 *    claims verification, guarantees, vendor endorsement or SHOPLINE
 *    acceptance, and `studio-copy.test.ts` scans for those claims;
 *  - keys are stable contracts for Tasks 6 and 7, which consume the same
 *    strings rather than re-translating them per component.
 *
 * Keys are namespaced `studio.*` by surface so a future page can find its
 * copy without guessing an unrelated prefix.
 */
export const STUDIO_COPY = {
  // -- shell / navigation ---------------------------------------------------
  "studio.nav.label": ["工作室", "Studio"],
  "studio.rail.workspace": ["工作區", "Workspace"],
  "studio.rail.newConversation": ["新對話", "New conversation"],
  "studio.rail.newConversationUnavailable": [
    "尚未提供建立對話功能。",
    "Creating conversations is not available yet.",
  ],
  "studio.rail.navigation": ["工作室導覽", "Studio navigation"],
  "studio.rail.overview": ["總覽", "Overview"],
  "studio.rail.conversations": ["對話", "Conversations"],
  "studio.rail.outputs": ["輸出", "Outputs"],
  "studio.rail.tools": ["工具", "Tools"],
  "studio.rail.settings": ["設定", "Settings"],
  "studio.rail.recent": ["最近的對話", "Recent conversations"],
  "studio.rail.recentEmpty": ["還沒有對話。", "No conversations yet."],
  "studio.rail.notAvailableInBuild": [
    "此版本只提供總覽頁；其餘導覽目的地尚未實作。",
    "This build only provides the overview page; the other destinations are not implemented yet.",
  ],

  // -- conversation home ----------------------------------------------------
  "studio.home.eyebrow": ["工作室", "STUDIO"],
  "studio.home.greeting": ["歡迎回來", "Welcome back"],
  "studio.home.intro": [
    "工作室是對話式的工作區介面。此版本是靜態外殼：沒有模型呼叫、沒有捏造數字，也不會傳送訊息。",
    "Studio is a conversational workspace surface. This build is a static shell: no model calls, no invented numbers and no message sending.",
  ],
  "studio.home.staticNotice": [
    "此頁未連接後端；所有動作保持停用。",
    "This page is not connected to a backend; every action stays disabled.",
  ],
  "studio.home.recentTitle": ["最近的對話", "Recent conversations"],
  "studio.home.recentEmpty": [
    "還沒有對話。建立及傳送功能尚未提供。",
    "No conversations yet. Creating and sending are not available yet.",
  ],

  // -- composer -------------------------------------------------------------
  "studio.composer.label": ["訊息", "Message"],
  "studio.composer.placeholder": [
    "詢問商品、品質或作業相關問題…",
    "Ask about listings, quality or jobs…",
  ],
  "studio.composer.send": ["傳送", "Send"],
  "studio.composer.sendingUnavailable": [
    "尚未提供傳送功能。",
    "Sending is not available yet.",
  ],
  "studio.composer.attach": ["附加檔案", "Attach files"],
  "studio.composer.attachUnavailable": [
    "尚未提供附加檔案功能。",
    "Attachments are not available yet.",
  ],
  "studio.composer.draftKept": [
    "訊息未能傳送時，草稿會保留。",
    "A failed send keeps your draft.",
  ],
  "studio.composer.disclaimer": [
    "AI 可能會出錯；重要數字請先核對。",
    "AI may be wrong; verify important numbers.",
  ],

  // -- deterministic overview ----------------------------------------------
  "studio.overview.title": ["工作區概況", "Workspace overview"],
  "studio.overview.rule": [
    "來自工作區記錄；不會呼叫 AI。",
    "From workspace records; no AI call.",
  ],
  "studio.overview.notYetAvailable": ["尚未提供", "Not yet available"],
  "studio.overview.pending": [
    "概況會由工作區記錄計算，讀取介面尚未實作；此區塊不會顯示推算或虛構數字。",
    "The overview is computed from workspace records. The read surface is not implemented yet; this card shows no estimated or invented numbers.",
  ],
  "studio.overview.openBlockingFlags": [
    "未解決的阻塞標記",
    "Open blocking flags",
  ],
  "studio.overview.unapprovedDrafts": ["未批准的草稿", "Unapproved drafts"],
  "studio.overview.failedJobs": [
    "待處理的失敗作業",
    "Failed jobs awaiting attention",
  ],
  "studio.overview.qualityGaps": ["品質缺口", "Quality gaps"],
  "studio.overview.lastImport": ["最近匯入", "Last import"],
  "studio.overview.lastExport": ["最近匯出", "Last export"],

  // -- template cards -------------------------------------------------------
  "studio.templates.title": ["角色範本", "Role templates"],
  "studio.templates.intro": [
    "範本只會把問題帶入輸入框，不會自動傳送。",
    "Templates only fill the composer; they never send.",
  ],
  "studio.templates.unavailableHint": [
    "未能使用的範本不可點擊，並會說明原因。",
    "Unavailable templates cannot be used and state why.",
  ],
  "studio.availability.ready": ["已就緒", "Ready"],
  "studio.availability.pilot": ["試行", "Pilot"],
  "studio.availability.planned": ["規劃中", "Planned"],
  "studio.availability.unavailable": ["未能提供", "Unavailable"],

  "studio.template.catalogFind.title": ["尋找商品記錄", "Find catalog records"],
  "studio.template.catalogFind.outcome": [
    "依記錄找出並解釋商品、品質問題與作業狀態。",
    "Find and explain listings, quality issues and jobs from records.",
  ],
  "studio.template.catalogFind.limitation": [
    "此階段標示為試行；規則式讀取尚未實作。",
    "Marked pilot for this phase; the rule-based read is not implemented yet.",
  ],
  "studio.template.standards.title": [
    "檢視上架標準",
    "Review listing standards",
  ],
  "studio.template.standards.outcome": [
    "說明哪些商品卡在批准或匯出，以及原因。",
    "Explain which listings block approval or export, and why.",
  ],
  "studio.template.standards.limitation": [
    "此階段標示為試行；規則式讀取尚未實作。",
    "Marked pilot for this phase; the rule-based read is not implemented yet.",
  ],
  "studio.template.listingDraft.title": ["上架草稿", "Listing draft"],
  "studio.template.listingDraft.outcome": [
    "從商品記錄起草上架內容，交由現有審核流程處理。",
    "Draft listing content from catalog records for the existing review flow.",
  ],
  "studio.template.listingDraft.limitation": [
    "尚未實作；草稿仍要在現有畫面審核。",
    "Not implemented yet; drafts are still reviewed in the existing screens.",
  ],
  "studio.template.productShot.title": ["圖片處理", "Image preparation"],
  "studio.template.productShot.outcome": [
    "準備衍生商品圖，交由現有產品圖流程審核。",
    "Prepare derived product images for the existing product-shot flow.",
  ],
  "studio.template.productShot.limitation": [
    "尚未實作；目前沒有可用的圖片工具。",
    "Not implemented yet; no image tool is available.",
  ],
  "studio.template.copyProposal.title": ["內容生成", "Copy proposal"],
  "studio.template.copyProposal.outcome": [
    "依商品記錄提出文案建議，交由編輯畫面採用。",
    "Propose copy from catalog records for the existing editor.",
  ],
  "studio.template.copyProposal.limitation": [
    "尚未實作；不會自動寫入商品內容。",
    "Not implemented yet; product content is never written automatically.",
  ],
  "studio.template.categoryMapping.title": ["分類映射", "Category mapping"],
  "studio.template.categoryMapping.outcome": [
    "提出分類對應建議，並附信心程度。",
    "Propose category mappings with a confidence note.",
  ],
  "studio.template.categoryMapping.limitation": [
    "尚未實作；分類仍由現有目錄流程套用。",
    "Not implemented yet; categories are still applied in the existing catalog flow.",
  ],
  "studio.template.supplierIntel.title": ["供應商情報", "Supplier intel"],
  "studio.template.supplierIntel.outcome": [
    "從已匯入資料提出供應商欄位建議。",
    "Propose supplier fields from imported records.",
  ],
  "studio.template.supplierIntel.limitation": [
    "尚未實作；建議須由人員檢視後儲存。",
    "Not implemented yet; proposals are reviewed and saved by a person.",
  ],
  "studio.template.customerReply.title": ["客服回覆", "Customer replies"],
  "studio.template.customerReply.outcome": [
    "草擬客服回覆。",
    "Draft customer replies.",
  ],
  "studio.template.customerReply.limitation": [
    "沒有收件匣資料來源，因此不提供此功能。",
    "No inbox data source exists, so this capability is unavailable.",
  ],
  "studio.template.merchantAudit.title": ["商家稽核", "Merchant audit"],
  "studio.template.merchantAudit.outcome": [
    "整理商品品質與記錄覆蓋的報告。",
    "Assemble a report from listing quality and record coverage.",
  ],
  "studio.template.merchantAudit.limitation": [
    "尚未實作；報告須由人員簽核，工作室不會批准或發佈。",
    "Not implemented yet; reports need human sign-off and Studio never approves or publishes.",
  ],
  "studio.template.logistics.title": ["物流跟進", "Logistics follow-up"],
  "studio.template.logistics.outcome": [
    "跟進訂單與出貨狀況。",
    "Follow up on orders and shipments.",
  ],
  "studio.template.logistics.limitation": [
    "沒有訂單或出貨資料來源，因此不提供此功能。",
    "No order or shipment data source exists, so this capability is unavailable.",
  ],

  // -- thread ---------------------------------------------------------------
  "studio.thread.title": ["對話", "Conversation"],
  "studio.thread.empty": [
    "此對話還沒有訊息。",
    "No messages in this conversation yet.",
  ],
  "studio.thread.operatorTurn": ["你的訊息", "Your message"],
  "studio.thread.followUps": ["延伸問題", "Follow-up questions"],

  // -- execution trace ------------------------------------------------------
  "studio.trace.title": ["執行步驟", "Execution trace"],
  "studio.trace.count": ["步", "steps"],
  "studio.trace.status.done": ["完成", "Done"],
  "studio.trace.status.running": ["執行中", "Running"],
  "studio.trace.status.unavailable": ["未能提供", "Unavailable"],
  "studio.trace.status.blocked": ["已封鎖", "Blocked"],
  "studio.trace.status.failed": ["失敗", "Failed"],

  // -- records answer / evidence -------------------------------------------
  "studio.evidence.title": ["來自你的記錄", "From your records"],
  "studio.evidence.check": ["檢查", "Check"],
  "studio.evidence.result": ["結果", "Result"],
  "studio.evidence.coverage.present": ["已有", "Present"],
  "studio.evidence.coverage.missing": ["缺少", "Missing"],
  "studio.evidence.coverage.unsupported": ["未支援", "Unsupported"],
  "studio.evidence.missingAction": [
    "缺少不等於零；請先開啟匯入或執行品質檢查。",
    "Missing is not zero; open an import or run a quality review first.",
  ],

  // -- model suggestion card ------------------------------------------------
  "studio.model.title": ["AI 建議 · 未經驗證", "AI suggestion · unverified"],
  "studio.model.notConfigured": [
    "未設定即時分析。",
    "Live analysis is not configured.",
  ],
  "studio.model.failed": [
    "即時分析未能完成；記錄答案仍然有效。",
    "Live analysis did not complete; the records answer still applies.",
  ],
  "studio.model.limitation": [
    "AI 建議未經驗證，也沒有寫入權限。",
    "AI suggestions are unverified and have no write authority.",
  ],

  // -- outputs and sign-off -------------------------------------------------
  "studio.outputs.title": ["輸出", "Outputs"],
  "studio.outputs.empty": ["沒有已儲存的輸出。", "No saved outputs."],
  "studio.outputs.version": ["版本", "Version"],
  "studio.outputs.asOf": ["資料截至", "As of"],
  "studio.outputs.scope": ["範圍", "Scope"],
  "studio.outputs.signoff": ["簽核狀態", "Sign-off state"],
  "studio.outputs.openInExisting": [
    "在現有畫面開啟",
    "Open in the existing screen",
  ],
  "studio.outputs.copyLink": ["複製連結", "Copy link"],
  "studio.signoff.draft": ["草稿", "Draft"],
  "studio.signoff.saved": ["已儲存", "Saved"],
  "studio.signoff.signedOff": ["已簽核", "Signed off"],
  "studio.signoff.discarded": ["已丟棄", "Discarded"],

  // -- tools and connections ------------------------------------------------
  "studio.connections.title": ["工具與連線", "Tools and connections"],
  "studio.connections.hostedTokens": ["託管 MCP 權杖", "Hosted MCP tokens"],
  "studio.connections.external": ["外部 MCP 連線", "External MCP connections"],
  "studio.connections.notConfigured": ["未設定", "Not configured"],
  "studio.connections.disabled": ["已停用", "Disabled"],
  "studio.connections.empty": [
    "沒有可用的連線。",
    "No connections are available.",
  ],

  // -- honest states (spec §2.4) --------------------------------------------
  "studio.honest.disabled": [
    "此工作區尚未啟用工作室。",
    "Studio is not enabled for this workspace.",
  ],
  "studio.honest.enableHint": [
    "工作區管理員可在工作室設定中啟用。",
    "A workspace administrator can enable it in Studio settings.",
  ],
  "studio.honest.notYetAvailable": ["尚未提供", "Not yet available"],
  "studio.honest.noDataSource": ["沒有資料來源", "No data source"],
  "studio.honest.disabledCapability": ["功能已停用", "Capability disabled"],
  "studio.honest.modelNotConfigured": [
    "未設定即時分析；只顯示記錄答案。",
    "Live analysis is not configured; only the records answer is shown.",
  ],
  "studio.honest.unknownOutcome": [
    "我們不知道供應商是否已收費或完成；不會自動重試。",
    "We do not know whether the provider charged or completed; nothing is retried automatically.",
  ],
  "studio.honest.quotaExhausted": [
    "預算或額度已用完；付費動作停用，讀取仍可使用。",
    "Budget or quota is exhausted; paid actions are disabled and reads still work.",
  ],
  "studio.honest.runFailed": [
    "執行失敗；沒有捏造答案，請重試。",
    "The run failed; no answer is invented. Try again.",
  ],
  "studio.honest.foreignThread": [
    "找不到此對話。",
    "This conversation could not be found.",
  ],

  // -- route states ---------------------------------------------------------
  "studio.loading": ["正在載入工作室…", "Loading Studio…"],
  "studio.notFound.title": ["找不到工作室頁面", "Studio page not found"],
  "studio.notFound.body": [
    "此頁面不存在，或工作室未為此工作區啟用。",
    "This page does not exist, or Studio is not enabled for this workspace.",
  ],
  "studio.notFound.back": ["返回工作台", "Return to Workbench"],
} as const satisfies Record<string, BilingualMessage>;

/** Every key in `STUDIO_COPY`, for typed consumption by later tasks. */
export type StudioCopyKey = keyof typeof STUDIO_COPY;

/**
 * Read one bilingual tuple for the active locale.
 *
 * This is the only supported reader: components never index `STUDIO_COPY`
 * directly, so a missing key is a compile error rather than a fallback string.
 */
export function studioCopy(locale: Locale, key: StudioCopyKey): string {
  const message: BilingualMessage = STUDIO_COPY[key];
  return localized(locale, message[0], message[1]);
}

/**
 * Keys whose zh-Hant or en value is empty/missing after trimming.
 *
 * Returns an empty array for a complete catalogue; the parity test asserts
 * exactly that, so a half-translated key cannot ship silently.
 */
export function studioCopyParity(): StudioCopyKey[] {
  const keys = Object.keys(STUDIO_COPY) as StudioCopyKey[];
  return keys.filter((key) => {
    const [zh, en] = STUDIO_COPY[key];
    return zh.trim().length === 0 || en.trim().length === 0;
  });
}
