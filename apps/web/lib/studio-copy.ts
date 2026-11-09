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
    "需要操作員或以上權限才能建立對話。",
    "An operator or higher role is required to create conversations.",
  ],
  "studio.rail.newConversationCreating": [
    "正在建立對話…",
    "Creating a conversation…",
  ],
  "studio.rail.newConversationFailed": [
    "未能建立對話，請重試。",
    "Could not create the conversation. Try again.",
  ],
  "studio.rail.navigation": ["工作室導覽", "Studio navigation"],
  "studio.rail.overview": ["總覽", "Overview"],
  "studio.rail.conversations": ["對話", "Conversations"],
  "studio.rail.outputs": ["輸出", "Outputs"],
  "studio.rail.tools": ["工具", "Tools"],
  "studio.rail.settings": ["設定", "Settings"],
  "studio.rail.recent": ["最近的對話", "Recent conversations"],
  "studio.rail.recentEmpty": [
    "還沒有對話；建立第一個對話後會顯示在這裡。",
    "No conversations yet; the first one will appear here.",
  ],
  "studio.rail.settingsUnavailable": [
    "設定頁尚未提供。",
    "Settings are not available yet.",
  ],
  "studio.rail.viewAllThreads": ["檢視所有對話", "View all conversations"],
  "studio.rail.recentTruncated": [
    "只顯示最近更新的對話。",
    "Only the most recently updated conversations are shown.",
  ],

  // -- conversation home ----------------------------------------------------
  "studio.home.eyebrow": ["工作室", "STUDIO"],
  "studio.home.greeting": ["歡迎回來", "Welcome back"],
  "studio.home.intro": [
    "工作室從工作區記錄回答問題；設定允許時另附清楚標示的即時分析建議。",
    "Studio answers from workspace records and, when configured, adds clearly labelled live analysis suggestions.",
  ],
  "studio.home.staticNotice": [
    "工作室不會在對話中批准或發佈；相關動作只會連到現有畫面。",
    "Studio never approves or publishes inside a conversation; those actions open the existing screens.",
  ],
  "studio.home.recentTitle": ["最近的對話", "Recent conversations"],
  "studio.home.recentEmpty": ["還沒有對話。", "No conversations yet."],
  "studio.home.composerTitle": ["開始對話", "Start a conversation"],
  "studio.home.templatesTitle": ["角色範本", "Role templates"],

  // -- composer -------------------------------------------------------------
  "studio.composer.label": ["訊息", "Message"],
  "studio.composer.placeholder": [
    "詢問商品、品質或作業相關問題…",
    "Ask about listings, quality or jobs…",
  ],
  "studio.composer.send": ["傳送", "Send"],
  "studio.composer.empty": ["請先輸入訊息。", "Enter a message first."],
  "studio.composer.working": ["正在處理…", "Working…"],
  "studio.composer.retry": ["重試傳送", "Retry send"],
  "studio.composer.hint": [
    "Enter 傳送，Shift+Enter 換行。",
    "Enter to send, Shift+Enter for a new line.",
  ],
  "studio.composer.skillLabel": ["已選技能", "Selected skill"],
  "studio.composer.clearSkill": ["清除技能", "Clear skill"],
  "studio.composer.newThreadHint": [
    "首次傳送會建立新對話。",
    "Sending starts a new conversation.",
  ],
  "studio.composer.tooLong": [
    "訊息上限為 2000 字元。",
    "Messages are limited to 2000 characters.",
  ],
  "studio.composer.viewerNote": [
    "你的角色只能閱讀；傳送需要操作員或以上權限。",
    "Your role can read only; sending requires operator or higher.",
  ],
  "studio.composer.attach": ["附加檔案", "Attach files"],
  "studio.composer.attachUnavailable": [
    "此介面未接上檔案上傳。",
    "This surface has no file-upload wiring.",
  ],
  "studio.composer.attachment.listLabel": ["附加檔案", "Attached files"],
  "studio.composer.attachment.hint": [
    "支援 JPG、PNG、WebP 或 PDF，最多 8 個檔案，每個上限 20 MB。",
    "JPG, PNG, WebP or PDF; up to 8 files, 20 MB each.",
  ],
  "studio.composer.attachment.uploading": ["正在上傳…", "Uploading…"],
  "studio.composer.attachment.uploaded": ["已上傳", "Uploaded"],
  "studio.composer.attachment.failed": [
    "無法上傳此檔案，請重試。",
    "This file could not be uploaded. Try again.",
  ],
  "studio.composer.attachment.cancelled": ["上傳已取消。", "Upload cancelled."],
  "studio.composer.attachment.unsupported": [
    "不支援的檔案類型。只接受 JPG、PNG、WebP 或 PDF。",
    "Unsupported file type. Use JPG, PNG, WebP or PDF.",
  ],
  "studio.composer.attachment.empty": [
    "檔案是空的，請重新選取。",
    "The file is empty. Choose it again.",
  ],
  "studio.composer.attachment.tooLarge": [
    "檔案超過 20 MB 上限。",
    "The file is larger than the 20 MB limit.",
  ],
  "studio.composer.attachment.limit": [
    "最多可附加 8 個檔案。",
    "Up to 8 files can be attached.",
  ],
  "studio.composer.attachment.waitForUploads": [
    "請等待上傳完成，或移除仍在處理的檔案。",
    "Wait for uploads to finish, or remove the files still in progress.",
  ],
  "studio.composer.attachment.retry": ["重試上傳", "Retry upload"],
  "studio.composer.attachment.remove": ["移除", "Remove"],
  "studio.composer.attachment.viewerNote": [
    "附加檔案需要操作員或以上權限。",
    "Attaching files requires operator or higher.",
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
  "studio.overview.loadFailed": [
    "未能讀取工作區概況；未顯示推算或虛構數字。",
    "The workspace overview could not be read; no estimated or invented numbers are shown.",
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
  "studio.overview.unavailableTile": [
    "尚未提供此記錄讀取。",
    "This record read is not available yet.",
  ],
  "studio.overview.totalListings": ["商品記錄", "Listing records"],
  "studio.overview.totalCount": ["共 {count} 個", "{count} in total"],
  "studio.overview.byStatus": ["依狀態：{statuses}", "By status: {statuses}"],
  "studio.overview.noListings": ["沒有商品記錄。", "No listing records."],
  "studio.overview.qualityAssessed": [
    "已評估 {totalAssessed} / {totalListings}",
    "{totalAssessed} of {totalListings} assessed",
  ],
  "studio.overview.qualityClean": ["無缺口 {count} 個", "{count} clean"],
  "studio.overview.qualityGapCount": ["有缺口 {count} 個", "{count} with gaps"],
  "studio.overview.projectionReady": ["彙總：就緒", "Projection: ready"],
  "studio.overview.projectionPending": ["彙總：更新中", "Projection: pending"],
  "studio.overview.projectionFailed": ["彙總：失敗", "Projection: failed"],
  "studio.overview.asOf": ["資料截至 {asOf}", "As of {asOf}"],
  "studio.overview.recentJobs": ["最近作業 {count} 筆", "{count} recent jobs"],
  "studio.overview.recentJobsEmpty": ["最近沒有作業記錄。", "No recent jobs."],
  "studio.overview.failedWithinRecent": [
    "最近 {count} 筆作業中有 {failed} 筆失敗",
    "{failed} failed within the {count} most recent jobs",
  ],
  "studio.overview.open": ["開啟記錄", "Open records"],

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
  "studio.templates.fill": ["帶入輸入框", "Fill the composer"],
  "studio.templates.fillHint": [
    "只會帶入輸入框，不會自動傳送。",
    "Only fills the composer; it never sends.",
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
    "只根據工作區現有記錄回答；記錄沒有的事項會標示為未知。",
    "Answers only from existing workspace records; anything not recorded is reported as unknown.",
  ],
  "studio.template.catalogFind.starter": [
    "尋找並解釋這些商品：",
    "Find and explain these listings: ",
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
    "只讀取商品、品質與作業記錄；不會讀取匯出紀錄。",
    "Reads listing, quality and job records only; export records are not read.",
  ],
  "studio.template.standards.starter": [
    "檢視並解釋目前的阻擋缺口：",
    "Review the current blocking gaps: ",
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
  "studio.thread.assistantTurn": ["工作室", "Studio"],
  "studio.thread.limitations": ["已知限制", "Known limitations"],
  "studio.thread.followUps": ["延伸問題", "Follow-up questions"],
  "studio.thread.skill": ["技能", "Skill"],
  "studio.thread.noSkill": ["未指定技能", "No skill selected"],
  "studio.thread.status.open": ["進行中", "Open"],
  "studio.thread.status.archived": ["已封存", "Archived"],
  "studio.thread.visibility.workspace": ["工作區可見", "Workspace"],
  "studio.thread.visibility.private": ["私人", "Private"],
  "studio.thread.share": ["複製對話連結", "Copy link to conversation"],
  "studio.thread.shareCopied": [
    "已複製連結到剪貼簿。",
    "Link copied to the clipboard.",
  ],
  "studio.thread.shareFailed": [
    "無法複製連結；請手動複製網址。",
    "Could not copy the link; copy the address manually.",
  ],
  "studio.thread.sharePrivateWarning": [
    "此對話為私人：只有你與管理員可以開啟此連結。",
    "This conversation is private: only you and admins can open this link.",
  ],
  "studio.thread.shareHint": [
    "分享的是目前網址；不會另行公開或變更可見範圍。",
    "Shares the current address only; nothing is published or made more visible.",
  ],
  "studio.thread.answered": ["已回覆", "Answered"],
  "studio.thread.partial": ["部分回答", "Partially answered"],
  "studio.thread.needsInput": ["需要更多資訊", "More information needed"],
  "studio.thread.invalidAssistant": [
    "此回覆無法顯示；沒有捏造內容。",
    "This reply could not be displayed; nothing is invented.",
  ],
  "studio.thread.invalidOperator": [
    "此訊息無法顯示。",
    "This message could not be displayed.",
  ],
  "studio.thread.replayed": [
    "此訊息先前已處理；顯示已儲存的回覆。",
    "This message was already processed; the saved reply is shown.",
  ],
  "studio.thread.sendFailed": [
    "訊息未能傳送；草稿已保留，可重試。",
    "The message was not sent; your draft was kept so you can retry.",
  ],
  "studio.thread.reload": ["重新載入對話", "Reload conversation"],
  "studio.thread.back": ["返回工作室首頁", "Back to Studio home"],
  "studio.thread.createdAt": ["建立於 {asOf}", "Created {asOf}"],
  "studio.thread.loading": ["正在載入對話…", "Loading conversation…"],
  "studio.thread.recentThreads": ["最近的對話", "Recent conversations"],

  // -- conversations list ---------------------------------------------------
  "studio.threads.title": ["對話", "Conversations"],
  "studio.threads.intro": [
    "依最近更新排序；只包含你在此工作區可讀取的對話。",
    "Ordered by most recent update; only conversations you can read in this workspace are listed.",
  ],
  "studio.threads.empty": ["還沒有對話。", "No conversations yet."],
  "studio.threads.error": [
    "未能讀取對話清單；沒有顯示推算或虛構的對話。",
    "The conversation list could not be loaded; no estimated or invented conversations are shown.",
  ],
  "studio.threads.truncated": [
    "只顯示最近更新的 50 個對話。",
    "Only the 50 most recently updated conversations are shown.",
  ],
  "studio.threads.searchLabel": ["搜尋對話", "Search conversations"],
  "studio.threads.searchPlaceholder": ["標題或技能", "Title or skill"],
  "studio.threads.searchAction": ["搜尋", "Search"],
  "studio.threads.searchEmpty": [
    "沒有符合搜尋的對話。",
    "No conversations match this search.",
  ],
  "studio.threads.searchSummary": [
    "搜尋「{query}」：{count} 個對話（伺服器篩選）。",
    "Search “{query}”: {count} conversation(s), filtered on the server.",
  ],
  "studio.threads.searchInvalid": [
    "搜尋字串最多 120 個字元；未套用篩選。",
    "A search is at most 120 characters; no filter was applied.",
  ],
  "studio.threads.updated": ["最近更新", "Last updated"],
  "studio.threads.open": ["開啟對話", "Open conversation"],

  // -- execution trace ------------------------------------------------------
  "studio.trace.title": ["執行步驟", "Execution trace"],
  "studio.trace.count": ["步", "steps"],
  "studio.trace.summary": [
    "執行步驟 · {count} 步",
    "Execution trace · {count} steps",
  ],
  "studio.trace.load": ["載入執行步驟", "Load execution trace"],
  "studio.trace.loading": ["正在載入執行步驟…", "Loading execution trace…"],
  "studio.trace.error": [
    "未能載入執行步驟。",
    "The execution trace could not be loaded.",
  ],
  "studio.trace.empty": [
    "此回覆沒有可顯示的執行步驟。",
    "This reply has no displayable execution steps.",
  ],
  "studio.trace.duration": ["{duration} 毫秒", "{duration} ms"],
  "studio.trace.stepKind.tool": ["工具", "Tool"],
  "studio.trace.stepKind.evidence": ["證據", "Evidence"],
  "studio.trace.stepKind.model": ["模型", "Model"],
  "studio.trace.stepKind.notice": ["提示", "Notice"],
  "studio.trace.stepKind.error": ["錯誤", "Error"],
  "studio.trace.stepKind.dispatch": ["派送", "Dispatch"],
  "studio.trace.status.done": ["完成", "Done"],
  "studio.trace.status.running": ["執行中", "Running"],
  "studio.trace.status.started": ["已開始", "Started"],
  "studio.trace.status.unavailable": ["未能提供", "Unavailable"],
  "studio.trace.status.blocked": ["已封鎖", "Blocked"],
  "studio.trace.status.failed": ["失敗", "Failed"],
  "studio.trace.status.info": ["資訊", "Info"],
  "studio.trace.unknown": [
    "此步驟沒有可顯示的詳情。",
    "No details are available for this step.",
  ],
  "studio.trace.assets_read": [
    "已讀取 {count} 個來源素材。",
    "Read {count} source asset(s).",
  ],
  "studio.trace.audit_read": [
    "已讀取 {datasets} 個稽核資料集。",
    "Read {datasets} audit dataset(s).",
  ],
  "studio.trace.category_evidence": [
    "已讀取商品與 {candidates} 個相似目錄項目。",
    "Read the listing and {candidates} similar catalog row(s).",
  ],
  "studio.trace.dispatch.done": [
    "已建立商品草稿 {listingId}；佇列狀態：{queueState}。",
    "Created listing draft {listingId}; queue state: {queueState}.",
  ],
  "studio.trace.toolId": ["工具 {tool}", "Tool {tool}"],
  "studio.trace.needs_input": [
    "需要更多資訊才能查詢，未執行任何讀取。",
    "More information is needed before querying; nothing was read.",
  ],
  "studio.trace.model.done": [
    "模型分析完成（{model}；輸入 {inputTokens}、輸出 {outputTokens}；略過 {droppedClaims} 條無依據主張）。",
    "Model analysis completed ({model}; {inputTokens} input, {outputTokens} output tokens; {droppedClaims} ungrounded claims dropped).",
  ],
  "studio.trace.model.failed": [
    "模型分析未完成（{category}）；記錄答案仍然有效。",
    "Model analysis did not complete ({category}); the records answer still applies.",
  ],
  "studio.trace.model.budget_blocked": [
    "預算未允許模型分析；只顯示記錄答案。",
    "Budget did not admit a model analysis; only the records answer is shown.",
  ],
  "studio.trace.model.not_admitted": [
    "模型分析未獲准（{reason}）。",
    "Model analysis was not admitted ({reason}).",
  ],
  "studio.trace.tool.done": [
    "已讀取 {tool}（{durationMs} 毫秒）。",
    "Read {tool} ({durationMs} ms).",
  ],
  "studio.trace.tool.unknown": [
    "未知的工具 {tool}；未執行。",
    "Unknown tool {tool}; nothing was run.",
  ],
  "studio.trace.tool.insufficient_role": [
    "權限不足，未執行 {tool}。",
    "Insufficient role; {tool} was not run.",
  ],
  "studio.trace.tool.invalid_arguments": [
    "工具參數不符，未執行 {tool}。",
    "Arguments did not match; {tool} was not run.",
  ],
  "studio.trace.tool.unavailable": [
    "{tool} 未能提供（{durationMs} 毫秒）。",
    "{tool} was unavailable ({durationMs} ms).",
  ],
  "studio.trace.tool.failed": [
    "{tool} 失敗（{durationMs} 毫秒）。",
    "{tool} failed ({durationMs} ms).",
  ],

  // -- tool labels (trace and connections use the same readable names) ------
  "studio.tool.catalog.search": ["搜尋商品目錄", "Search catalog"],
  "studio.tool.catalog.get": ["讀取商品詳情", "Get listing detail"],
  "studio.tool.quality.get_gaps": ["讀取品質缺口", "Get quality gaps"],
  "studio.tool.imports.list": ["列出匯入紀錄", "List imports"],
  "studio.tool.exports.get": ["讀取匯出紀錄", "Get export record"],
  "studio.tool.jobs.list": ["列出作業記錄", "List jobs"],
  "studio.tool.assets.list": ["列出商品素材", "List listing assets"],
  "studio.tool.listing.get_run_status": [
    "讀取上架流程狀態",
    "Get listing run status",
  ],
  "studio.tool.listing.create_draft": ["建立商品草稿", "Create listing draft"],
  "studio.tool.listing.propose_copy": ["建立文案建議", "Propose listing copy"],

  // -- records answer -------------------------------------------------------
  "studio.answer.heading": [
    "技能：{skill}（版本 {skillVersion}）",
    "Skill: {skill} (version {skillVersion})",
  ],
  "studio.answer.coverage": [
    "已解析 {present} 個來源；缺少 {missing} 個。",
    "Sources present: {present}; missing: {missing}.",
  ],
  "studio.answer.catalog_found": [
    "找到 {count} 筆符合的商品記錄。結果已截斷：{truncated}。",
    "Found {count} matching listing records. Results truncated: {truncated}.",
  ],
  "studio.answer.quality_summary": [
    "品質概況：共 {totalListings} 個商品，已評估 {totalAssessed} 個，無缺口 {cleanCount} 個，有缺口 {hasGapsCount} 個（彙總狀態：{projectionState}）。",
    "Quality summary: {totalListings} listings, {totalAssessed} assessed, {cleanCount} clean, {hasGapsCount} with gaps (projection: {projectionState}).",
  ],
  "studio.answer.recent_jobs": [
    "最近的作業記錄：{count} 筆。",
    "Recent jobs: {count}.",
  ],
  "studio.answer.gap_review": [
    "內容缺口：{contentGaps} 個，其中阻塞 {blockingGaps} 個。",
    "Content gaps: {contentGaps}, of which {blockingGaps} blocking.",
  ],
  "studio.answer.workspace_quality": [
    "工作區品質：共 {totalListings} 個商品，無缺口 {cleanCount} 個，有缺口 {hasGapsCount} 個，沒有生效版本 {noActiveVersion} 個。",
    "Workspace quality: {totalListings} listings, {cleanCount} clean, {hasGapsCount} with gaps, {noActiveVersion} without an active version.",
  ],
  "studio.answer.copy_current": [
    "目前文案：{fields} 個欄位，{present} 個已有內容，{gaps} 個缺口；建議狀態：{proposal}。",
    "Current copy: {fields} field(s), {present} present, {gaps} gap(s); proposal: {proposal}.",
  ],
  "studio.answer.copy_proposal": [
    "文案建議：{fields} 個欄位；已略過 {dropped} 個沒有依據的建議。",
    "Copy proposal: {fields} field(s); {dropped} ungrounded suggestion(s) dropped.",
  ],
  "studio.answer.audit_report": [
    "稽核報告：商品 {listings} 個，無缺口 {clean} 個，有缺口 {gaps} 個，匯出紀錄 {exports} 筆。",
    "Audit report: {listings} listings, {clean} clean, {gaps} with gaps, {exports} export attempt(s).",
  ],
  "studio.answer.audit_period": [
    "期間 {from} 至 {to}（{days} 天）：期內匯出 {attempts} 筆；商品數量與品質為目前快照。",
    "Period {from} to {to} ({days} days): {attempts} export attempt(s) in period; listing counts and quality are current snapshots.",
  ],
  "studio.answer.audit_current": [
    "未指定期間：顯示目前總計與最近 {attempts} 筆匯出紀錄。",
    "No period was named: current totals and the latest {attempts} export attempt(s) are shown.",
  ],
  "studio.answer.draft_ready": [
    "已準備 {assets} 個來源素材；缺少 {missing} 個。確認後才會建立草稿。",
    "Prepared {assets} source asset(s); {missing} missing. The draft is only created after explicit confirmation.",
  ],
  "studio.answer.category_map": [
    "分類對應：讀取商品後找到 {candidates} 個相似目錄項目；目前分類：{current}。",
    "Category mapping: read the listing and found {candidates} similar catalog row(s); current category: {current}.",
  ],
  "studio.answer.category_map_suggestions": [
    "分類建議 {suggestions} 個；已略過 {dropped} 個無依據、重複或等於目前分類的建議。",
    "{suggestions} category suggestion(s); {dropped} ungrounded, duplicate or current-category suggestion(s) dropped.",
  ],

  // -- evidence checks ------------------------------------------------------
  "studio.check.catalog_matches": [
    "符合條件的商品：{count} 筆。結果已截斷：{truncated}。",
    "Matching listings: {count}. Truncated: {truncated}.",
  ],
  "studio.check.listing_status": [
    "商品 {listingId}：狀態 {status}；生效版本：{activeVersion}。",
    "Listing {listingId}: status {status}; active version: {activeVersion}.",
  ],
  "studio.check.quality_summary": [
    "商品 {totalListings} 個；已評估 {totalAssessed} 個；無缺口 {cleanCount} 個；有缺口 {hasGapsCount} 個；彙總狀態 {projectionState}。",
    "Listings {totalListings}; assessed {totalAssessed}; clean {cleanCount}; with gaps {hasGapsCount}; projection {projectionState}.",
  ],
  "studio.check.recent_jobs": [
    "近期作業：{count} 筆。",
    "Recent jobs: {count}.",
  ],
  "studio.check.content_gap": [
    "商品 {listingId}：缺口 {code}；阻塞核准：{blocking}。",
    "Listing {listingId}: gap {code}; blocking: {blocking}.",
  ],
  "studio.check.copy_current": [
    "建議欄位 {field}：目前有內容：{present}。",
    "Proposal field {field}: current content present: {present}.",
  ],
  "studio.check.copy_gap": [
    "商品 {listingId}：缺口 {code}；阻塞核准：{blocking}。",
    "Listing {listingId}: gap {code}; blocking: {blocking}.",
  ],
  "studio.check.audit_listing_counts": [
    "工作區商品總數：{total}。",
    "Workspace listings: {total}.",
  ],
  "studio.check.audit_quality": [
    "品質：共 {totalListings} 個；無缺口 {cleanCount} 個；有缺口 {hasGapsCount} 個。",
    "Quality: {totalListings} listings; {cleanCount} clean; {hasGapsCount} with gaps.",
  ],
  "studio.check.audit_exports": [
    "匯出紀錄 {count} 筆（就緒 {ready}、失敗 {failed}）；期內 {inPeriod} 筆。",
    "Export attempts {count} (ready {ready}, failed {failed}); {inPeriod} in period.",
  ],
  "studio.check.audit_period": [
    "期間 {from} 至 {to}（{days} 天）；期內匯出 {attempts} 筆。",
    "Period {from} to {to} ({days} days); {attempts} export attempt(s) in period.",
  ],
  "studio.check.draft_assets": [
    "來源素材：{count} 個可用；缺少 {missing} 個；已附在其他商品 {attached} 個。",
    "Source assets: {count} usable; {missing} missing; {attached} already attached to another listing.",
  ],
  "studio.check.category_listing": [
    "商品 {listingId}：狀態 {status}；生效版本：{activeVersion}。",
    "Listing {listingId}: status {status}; active version: {activeVersion}.",
  ],
  "studio.check.category_current": [
    "商品 {listingId} 的目前分類：{current}。",
    "Current category for listing {listingId}: {current}.",
  ],
  "studio.check.category_catalog_candidates": [
    "相似目錄項目：{candidates} 個；結果已截斷：{truncated}。",
    "Similar catalog rows: {candidates}; truncated: {truncated}.",
  ],

  // -- honest read limits ---------------------------------------------------
  "studio.limit.catalog_unavailable": [
    "未能讀取商品目錄；未以零值代替。",
    "The catalog could not be read; no zero is substituted.",
  ],
  "studio.limit.listing_unavailable": [
    "未能讀取商品 {listingId} 的記錄；未顯示推算內容。",
    "The record for listing {listingId} could not be read; nothing is estimated.",
  ],
  "studio.limit.quality_unavailable": [
    "未能讀取品質彙總；未提供品質數字。",
    "The quality summary could not be read; no quality numbers are shown.",
  ],
  "studio.limit.jobs_unavailable": [
    "未能讀取作業記錄。",
    "Job records could not be read.",
  ],
  "studio.limit.results_truncated": [
    "結果多於顯示上限，只顯示部分。",
    "There are more results than the display limit; only some are shown.",
  ],
  "studio.limit.exports_not_read": [
    "此技能不會讀取匯出紀錄；未知不等於沒有匯出。",
    "This skill does not read export records; unknown is not the same as no export.",
  ],
  "studio.limit.copy_model_required": [
    "未設定即時分析，因此未產生文案建議；只顯示記錄答案。",
    "Live analysis is not configured, so no copy proposal was produced; only the records answer is shown.",
  ],
  "studio.limit.copy_unavailable": [
    "未能讀取目前文案；未提出任何建議。",
    "The current copy could not be read, so no proposal was made.",
  ],
  "studio.limit.audit_period_unset": [
    "未指定報告期間；數字是讀取時的目前總計，不是期間統計。",
    "No report period was named; the numbers are current totals at read time, not period statistics.",
  ],
  "studio.limit.audit_period_invalid": [
    "無法解析期間；已改用目前總計，並未猜測期間。",
    "The period could not be parsed; current totals are shown and no period was guessed.",
  ],
  "studio.limit.audit_period_applied": [
    "只有匯出紀錄依期間 {from} 至 {to} 篩選；其他區段仍為目前快照。",
    "Only export attempts are filtered to {from} to {to}; other sections remain current snapshots.",
  ],
  "studio.limit.audit_counts_current": [
    "商品狀態數量是目前的快照，並非期間內的統計。",
    "Listing status counts are current snapshots, not period-scoped counts.",
  ],
  "studio.limit.audit_quality_current": [
    "品質概況是目前的快照，並非期間內的統計。",
    "The quality summary is a current snapshot, not a period-scoped statistic.",
  ],
  "studio.limit.audit_exports_unavailable": [
    "未能讀取匯出紀錄；不以零代替。",
    "Export records could not be read; no zero is substituted.",
  ],
  "studio.limit.draft_assets_missing": [
    "缺少 {count} 個來源素材；未準備任何派送動作。",
    "{count} source asset(s) are missing; no dispatch was prepared.",
  ],
  "studio.limit.copy_fields_dropped": [
    "已略過 {count} 個沒有依據的建議欄位。",
    "{count} proposed field(s) were dropped because their evidence did not resolve.",
  ],
  "studio.limit.category_not_applied": [
    "分類建議只供審核；不會自動套用到商品或目錄。",
    "Category suggestions are for review only; nothing is applied to the listing or catalog automatically.",
  ],
  "studio.limit.category_listing_unavailable": [
    "未能讀取商品 {listingId} 的記錄；未提供分類建議。",
    "The record for listing {listingId} could not be read; no category suggestions are offered.",
  ],
  "studio.limit.category_catalog_unavailable": [
    "未能讀取相似目錄項目；未以虛構分類代替。",
    "Similar catalog rows could not be read; no invented categories are substituted.",
  ],
  "studio.limit.category_current_unknown": [
    "正式商品內容沒有分類欄位，因此目前分類顯示為未知。",
    "Canonical listing content has no category field, so the current category is shown as unknown.",
  ],
  "studio.limit.category_model_unavailable": [
    "未設定可用的即時模型，因此只提供確定性證據與空白建議。",
    "No usable live model is configured, so only deterministic evidence and an empty suggestion list are provided.",
  ],
  "studio.limit.category_suggestions_dropped": [
    "已略過 {count} 個沒有依據或重複的分類建議。",
    "{count} category suggestion(s) were dropped because their evidence did not resolve or they duplicated another path.",
  ],

  // -- needs input and follow-ups ------------------------------------------
  "studio.needs_input.catalog_query": [
    "請提供要查詢的商品、SKU 或關鍵字。",
    "Provide the listing, SKU or keyword to look up.",
  ],
  "studio.needs_input.copy_listing": [
    "請提供要提出文案建議的商品。",
    "Provide the listing to propose copy for.",
  ],
  "studio.needs_input.draft_assets": [
    "請附上或貼上至少一個來源素材識別碼。",
    "Attach or paste at least one source asset id.",
  ],
  "studio.needs_input.category_listing": [
    "請提供要建議分類的商品（貼上商品識別碼）。",
    "Provide the listing to propose a category for (paste its listing id).",
  ],
  "studio.followup.explain_status": [
    "解釋商品目前的狀態",
    "Explain a listing's current status",
  ],
  "studio.followup.review_gaps": [
    "檢視阻擋核准或匯出的缺口",
    "Review gaps blocking approval or export",
  ],
  "studio.followup.list_attention": [
    "列出需要注意的商品",
    "List listings that need attention",
  ],
  "studio.followup.open_listing": [
    "開啟某個商品的記錄",
    "Open a listing's record",
  ],
  "studio.followup.confirm_dispatch": [
    "確認後建立商品草稿",
    "Create the listing draft after confirming",
  ],
  "studio.followup.open_jobs": [
    "查看作業與處理狀態",
    "Check jobs and processing status",
  ],
  "studio.followup.category_review": [
    "在審核畫面核對分類建議",
    "Review the category suggestions in the review workspace",
  ],

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
  "studio.evidence.sources": ["來源記錄", "Source records"],
  "studio.evidence.checks": ["檢查", "Checks"],
  "studio.evidence.noSources": [
    "此回覆沒有儲存來源列。",
    "No source rows are stored with this reply.",
  ],
  "studio.evidence.restricted": [
    "受限記錄；不顯示內容。",
    "Restricted record; content is not shown.",
  ],
  "studio.evidence.openSource": ["開啟來源", "Open source"],
  "studio.evidence.checkState.ok": ["通過", "OK"],
  "studio.evidence.checkState.gap": ["缺口", "Gap"],
  "studio.evidence.checkState.missing": ["缺少", "Missing"],
  "studio.evidence.checkState.unsupported": ["未支援", "Unsupported"],
  "studio.evidence.sourceKind.listing": ["商品", "Listing"],
  "studio.evidence.sourceKind.catalog": ["商品目錄", "Catalog"],
  "studio.evidence.sourceKind.quality": ["品質", "Quality"],
  "studio.evidence.sourceKind.source_import": ["來源匯入", "Source import"],
  "studio.evidence.sourceKind.export_attempt": ["匯出紀錄", "Export record"],
  "studio.evidence.sourceKind.job": ["作業", "Job"],
  "studio.evidence.sourceKind.audit": ["稽核", "Audit"],
  "studio.evidence.sourceKind.website": ["網站", "Website"],
  "studio.evidence.sourceKind.workbook": ["工作簿", "Workbook"],
  "studio.evidence.sourceKind.shopline_projection": [
    "商店投影",
    "Store projection",
  ],

  // -- model suggestion card ------------------------------------------------
  "studio.model.title": ["AI 建議 · 未經驗證", "AI suggestion · unverified"],
  "studio.model.notConfigured": [
    "未設定即時分析。",
    "Live analysis is not configured.",
  ],
  "studio.model.configured": [
    "由已設定的即時分析產生；內容未經驗證。",
    "Produced by configured live analysis; unverified.",
  ],
  "studio.model.failed": [
    "即時分析未能完成；記錄答案仍然有效。",
    "Live analysis did not complete; the records answer still applies.",
  ],
  "studio.model.limitation": [
    "AI 建議未經驗證，也沒有寫入權限。",
    "AI suggestions are unverified and have no write authority.",
  ],
  "studio.model.claims": ["主張", "Claims"],
  "studio.model.claimRefs": ["依據：{refs}", "Evidence: {refs}"],
  "studio.model.droppedClaims": [
    "{count} 條主張因依據未能解析而未顯示。",
    "{count} claims were dropped because their evidence did not resolve.",
  ],
  "studio.model.noClaims": ["沒有可顯示的主張。", "No claims to show."],

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
  "studio.outputs.pending": [
    "技能儲存成品後會顯示於此；輸出與簽核尚未實作。",
    "Outputs appear here after a skill saves an artifact; outputs and sign-off are not implemented yet.",
  ],
  "studio.outputs.intro": [
    "只顯示已儲存的成品，並附版本、資料時間與簽核狀態。",
    "Only saved artifacts are shown, with their version, as-of time and sign-off state.",
  ],
  "studio.outputs.filtersTitle": ["篩選成品", "Filter artifacts"],
  "studio.outputs.searchLabel": ["搜尋標題", "Search titles"],
  "studio.outputs.searchPlaceholder": ["成品標題", "Artifact title"],
  "studio.outputs.filterKind": ["類型", "Kind"],
  "studio.outputs.filterAllKinds": ["所有類型", "All kinds"],
  "studio.outputs.filterStatus": ["狀態", "Status"],
  "studio.outputs.filterAllStatuses": ["所有狀態", "All statuses"],
  "studio.outputs.filterApply": ["套用篩選", "Apply filters"],
  "studio.outputs.filterClear": ["清除篩選", "Clear filters"],
  "studio.outputs.filterSummary": [
    "篩選結果：{count} 個成品（伺服器篩選；搜尋：{query}）。",
    "Filtered result: {count} artifact(s), filtered on the server (search: {query}).",
  ],
  "studio.outputs.filterInvalid": [
    "篩選參數無效；未套用篩選。",
    "The filter parameters are invalid; no filter was applied.",
  ],
  "studio.outputs.filteredEmpty": [
    "沒有符合篩選的成品。",
    "No artifacts match these filters.",
  ],
  "studio.signoff.draft": ["草稿", "Draft"],
  "studio.signoff.saved": ["已儲存", "Saved"],
  "studio.signoff.signedOff": ["已簽核", "Signed off"],
  "studio.signoff.discarded": ["已丟棄", "Discarded"],

  // -- output cards (plan Task 9) -------------------------------------------
  "studio.outputs.kind.copy_proposal": ["文案建議", "Copy proposal"],
  "studio.outputs.kind.gap_report": ["缺口報告", "Gap report"],
  "studio.outputs.kind.merchant_audit": ["商家稽核", "Merchant audit"],
  "studio.outputs.kind.finding": ["發現", "Finding"],
  "studio.outputs.kind.unknown": ["其他成品", "Other artifact"],
  "studio.outputs.artifact": ["成品", "Artifact"],
  "studio.outputs.currentVersion": [
    "目前版本 {version}",
    "Current version {version}",
  ],
  "studio.outputs.revision": ["版本 {revision}", "Revision {revision}"],
  "studio.outputs.digest": ["內容摘要 {digest}", "Content digest {digest}"],
  "studio.outputs.loading": ["正在載入成品…", "Loading artifact…"],
  "studio.outputs.loadError": [
    "未能載入成品；未顯示推算內容。",
    "The artifact could not be loaded; nothing is estimated.",
  ],
  "studio.outputs.invalidPayload": [
    "此成品的內容無法顯示；沒有捏造內容。",
    "This artifact's content could not be displayed; nothing is invented.",
  ],
  "studio.outputs.save": ["儲存成品", "Save artifact"],
  "studio.outputs.saving": ["正在儲存…", "Saving…"],
  "studio.outputs.signOff": ["簽核", "Sign off"],
  "studio.outputs.signingOff": ["正在簽核…", "Signing off…"],
  "studio.outputs.saveSucceeded": [
    "已儲存；伺服器重新讀取後確認。",
    "Saved; confirmed by the server readback.",
  ],
  "studio.outputs.signOffSucceeded": [
    "已簽核；伺服器重新讀取後確認。",
    "Signed off; confirmed by the server readback.",
  ],
  "studio.outputs.saveFailed": [
    "未能儲存成品，請重試。",
    "The artifact could not be saved. Try again.",
  ],
  "studio.outputs.signOffFailed": [
    "未能簽核，請重試。",
    "The artifact could not be signed off. Try again.",
  ],
  "studio.outputs.signOffRole": [
    "需要審核員或以上權限才能簽核。",
    "A reviewer or higher role is required to sign off.",
  ],
  "studio.outputs.signOffNeedsSaved": [
    "需要先儲存成品才能簽核。",
    "Save the artifact before signing off.",
  ],
  "studio.outputs.openThread": ["開啟原始對話", "Open the source conversation"],
  "studio.outputs.viewArtifact": ["檢視成品", "View artifact"],
  "studio.outputs.previewUnavailable": [
    "此成品類型尚未提供內嵌預覽。",
    "Inline preview is not available for this artifact kind.",
  ],
  "studio.outputs.expandHint": [
    "展開以載入成品的版本內容。",
    "Expand to load the artifact's version content.",
  ],
  "studio.outputs.truncated": [
    "只顯示最近的成品。",
    "Only the most recent artifacts are shown.",
  ],
  "studio.outputs.listError": [
    "未能讀取成品清單；沒有顯示推算內容。",
    "The artifact list could not be loaded; nothing is estimated.",
  ],
  "studio.outputs.emptyHint": [
    "技能儲存成品後會顯示在這裡。",
    "Artifacts appear here after a skill saves one.",
  ],
  "studio.outputs.savedReadback": [
    "狀態以伺服器回應為準；重新載入可核實儲存版本。",
    "The server response is authoritative; reload to verify the saved version.",
  ],
  "studio.outputs.receiptTitle": ["匯出簽章收據", "Export receipt"],
  "studio.outputs.receiptPending": [
    "正在讀取匯出收據…",
    "Reading the export receipt…",
  ],
  "studio.outputs.receiptSigned": [
    "由本工作區簽署（HMAC-SHA256，金鑰 {keyId}）；簽章前綴 {signature}…。這不是外部驗證或核准；請用下載的 JSON 依 runbook 核實。",
    "Signed by this workspace (HMAC-SHA256, key {keyId}); signature prefix {signature}…. This is not external verification or approval; verify the downloaded JSON with the runbook recipe.",
  ],
  "studio.outputs.receiptUnsigned": [
    "未設定匯出簽署金鑰；下載的 JSON 只有內容摘要，沒有簽章。",
    "No export signing key is configured; the downloaded JSON is digest-only.",
  ],
  "studio.outputs.receiptFailed": [
    "未能讀取匯出收據；下載的 JSON 仍會帶有收據。",
    "Could not read the export receipt; the downloaded JSON still carries it.",
  ],
  "studio.outputs.receiptHint": [
    "收據由伺服器計算；獨立核實需要工作區金鑰（見 runbook）。",
    "The receipt is server-computed; independent verification needs the workspace key (see the runbook).",
  ],

  // -- review card (plan Task 9) --------------------------------------------
  "studio.review.title": [
    "建議內容 · 須人工審核",
    "Proposed content · human approval required",
  ],
  "studio.review.listing": ["商品 {listingId}", "Listing {listingId}"],
  "studio.review.activeVersion": [
    "生效版本 {version}",
    "Active version {version}",
  ],
  "studio.review.asOf": ["資料截至 {asOf}", "As of {asOf}"],
  "studio.review.table.field": ["欄位", "Field"],
  "studio.review.table.current": ["目前", "Current"],
  "studio.review.table.proposed": ["建議", "Proposed"],
  "studio.review.table.evidence": ["依據", "Evidence"],
  "studio.review.evidenceNone": ["沒有依據", "No evidence"],
  "studio.review.notAvailable": ["未提供", "Not provided"],
  "studio.review.noFields": ["沒有建議欄位。", "No proposed fields."],
  "studio.review.limitations": ["限制", "Limitations"],
  "studio.review.approvalGate": [
    "須由人員審核；工作室不會批准或發佈。",
    "Requires human review; Studio never approves or publishes.",
  ],
  "studio.review.noCanonicalWrite": [
    "建議內容不會寫入正式商品資料。",
    "The proposal never writes canonical listing data.",
  ],
  "studio.review.openReview": [
    "在審核畫面開啟",
    "Open in the review workspace",
  ],
  "studio.review.invalidPayload": [
    "此建議的內容無法顯示；沒有捏造內容。",
    "This proposal could not be displayed; nothing is invented.",
  ],

  // -- finding card (C1) ----------------------------------------------------
  "studio.finding.title": ["分類對應建議", "Category mapping proposal"],
  "studio.finding.listing": ["商品 {listingId}", "Listing {listingId}"],
  "studio.finding.currentCategory": ["目前分類", "Current category"],
  "studio.finding.unknown": ["未知", "Unknown"],
  "studio.finding.suggestions": ["建議分類", "Suggested categories"],
  "studio.finding.suggestionPath": ["分類路徑", "Category path"],
  "studio.finding.confidence": ["信心", "Confidence"],
  "studio.finding.evidence": ["依據", "Evidence"],
  "studio.finding.rationale": ["理由", "Rationale"],
  "studio.finding.limitations": ["限制", "Limitations"],
  "studio.finding.emptySuggestions": [
    "沒有可顯示的建議；證據與限制仍已保存。",
    "No suggestions to show; the evidence and limitations are still stored.",
  ],
  "studio.finding.notApplied": [
    "尚未套用 — 分類只會在既有目錄流程中由人員更改。",
    "Not applied — a person can only change the category in the existing catalog flow.",
  ],
  "studio.finding.reviewNote": [
    "須人工審核；工作室不會寫入正式商品資料。",
    "Requires human review; Studio never writes canonical listing data.",
  ],
  "studio.finding.openReview": [
    "在審核畫面開啟",
    "Open in the review workspace",
  ],
  "studio.finding.invalidPayload": [
    "此發現的內容無法顯示；沒有捏造內容。",
    "This finding could not be displayed; nothing is invented.",
  ],
  "studio.review.copyProposed": ["複製建議值", "Copy proposed"],
  "studio.review.copyAll": ["複製全部建議值", "Copy all proposed values"],
  "studio.review.copied": ["已複製", "Copied"],
  "studio.review.copyFailed": [
    "無法複製到剪貼簿。",
    "Could not copy to the clipboard.",
  ],
  "studio.review.notApplied": [
    "尚未套用 — 請在審核畫面套用。",
    "Not applied — apply only in the review screen.",
  ],
  "studio.review.exportTitle": ["匯出", "Export"],
  "studio.review.exportJson": ["下載 JSON", "Download JSON"],
  "studio.review.exportPdf": ["下載 PDF", "Download PDF"],
  "studio.review.exportSavedOnly": [
    "匯出只提供已儲存或已簽核的版本。",
    "Only a saved or signed-off artifact can be exported.",
  ],
  "studio.review.saveBeforeExport": [
    "請先儲存，才能匯出。",
    "Save before exporting.",
  ],

  // -- listing review handoff (B2) -------------------------------------------
  "studio.handoff.title": ["工作室建議", "Studio proposal"],
  "studio.handoff.requiresReview": [
    "工作室建議 — 須人工審核。此處不會自動套用任何內容。",
    "Studio proposal — requires human review. Nothing here is applied automatically.",
  ],
  "studio.handoff.notApplied": [
    "尚未套用；只可複製到審核表單。",
    "Not applied; you can only copy values into the review form.",
  ],
  "studio.handoff.current": ["目前", "Current"],
  "studio.handoff.proposed": ["建議", "Proposed"],
  "studio.handoff.copyField": ["複製建議值", "Copy proposed"],
  "studio.handoff.copyAll": ["複製全部建議值", "Copy all proposed values"],
  "studio.handoff.copied": ["已複製", "Copied"],
  "studio.handoff.copyFailed": [
    "無法複製到剪貼簿。",
    "Could not copy to the clipboard.",
  ],
  "studio.handoff.dismiss": ["關閉建議", "Dismiss proposal"],
  "studio.handoff.source": [
    "來自工作室成品；只讀顯示，不會改動表單。",
    "From a Studio artifact; read-only, the form is not changed.",
  ],

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
  "studio.connections.intro": [
    "此頁只陳述實際狀態：沒有偽造的連線，也沒有可直接開啟的外部存取。",
    "This page states the actual state only: no invented connections and no external access that can be switched on here.",
  ],
  "studio.connections.internalTitle": ["內部工具", "Internal tools"],
  "studio.connections.internalIntro": [
    "已登記的工具及其限制；登記不代表已開放外部存取。",
    "Registered tools and their limits; being registered does not mean external access is open.",
  ],
  "studio.connections.table.tool": ["工具", "Tool"],
  "studio.connections.table.kind": ["類型", "Kind"],
  "studio.connections.table.minRole": ["最低角色", "Minimum role"],
  "studio.connections.table.capability": ["功能代號", "Capability"],
  "studio.connections.table.state": ["狀態", "State"],
  "studio.connections.kind.read": ["讀取", "Read"],
  "studio.connections.kind.propose": ["建議", "Propose"],
  "studio.connections.kind.dispatch": ["派送", "Dispatch"],
  "studio.connections.planned": [
    "規劃中；尚未實作。",
    "Planned; not implemented yet.",
  ],
  "studio.role.viewer": ["檢視者", "Viewer"],
  "studio.role.operator": ["操作員", "Operator"],
  "studio.role.reviewer": ["審核員", "Reviewer"],
  "studio.role.admin": ["管理員", "Admin"],
  "studio.role.owner": ["擁有者", "Owner"],
  "studio.connections.toolState.read": [
    "讀取工具；只由已啟用的技能使用。",
    "Read tool; used only by enabled skills.",
  ],
  "studio.connections.toolState.propose": [
    "已登記；尚未開放執行。",
    "Registered; not executable yet.",
  ],
  "studio.connections.toolState.dispatch": [
    "已登記；尚未開放執行。",
    "Registered; not executable yet.",
  ],
  "studio.connections.hostedBody": [
    "託管 MCP 伺服器尚未實作；目前沒有外部呼叫者可以存取工作區記錄。",
    "The hosted MCP server is not implemented; no external caller can reach workspace records yet.",
  ],
  "studio.connections.externalBody": [
    "外部 MCP 連線預設停用；不接受使用者提供的端點或憑證。",
    "External MCP connections are disabled by default; no user-supplied endpoint or credential is accepted.",
  ],
  "studio.connections.blockedTitle": ["受阻的連線", "Blocked connections"],
  "studio.connections.whatsapp": [
    "WhatsApp：沒有支援的通道，維持封鎖。",
    "WhatsApp: no supported channel exists; stays blocked.",
  ],
  "studio.connections.customerService": [
    "客服收件匣：沒有資料來源，維持封鎖。",
    "Customer-service inbox: no data source exists; stays blocked.",
  ],
  "studio.connections.logistics": [
    "物流與訂單：沒有資料來源，維持封鎖。",
    "Logistics and orders: no data source exists; stays blocked.",
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

  // -- dispatch card (plan Task 10) -----------------------------------------
  "studio.dispatch.title": ["建立商品草稿", "Create listing draft"],
  "studio.dispatch.intro": [
    "此動作會依來源素材建立商品草稿，並交由現有上線流程處理。",
    "This creates a listing draft from the source assets and hands it to the existing listing pipeline.",
  ],
  "studio.dispatch.assetCount": [
    "來源素材 {count} 個",
    "{count} source asset(s)",
  ],
  "studio.dispatch.note": ["備註：{note}", "Note: {note}"],
  "studio.dispatch.noNote": ["沒有備註", "No note"],
  "studio.dispatch.review": ["檢視並確認", "Review and confirm"],
  "studio.dispatch.warning": [
    "確認後會建立正式商品草稿；工作室不會自動核准或發佈。",
    "Confirming creates a real listing draft; Studio never approves or publishes automatically.",
  ],
  "studio.dispatch.confirm": ["確認建立草稿", "Confirm create draft"],
  "studio.dispatch.cancel": ["取消", "Cancel"],
  "studio.dispatch.sending": ["正在建立草稿…", "Creating the draft…"],
  "studio.dispatch.notReady": [
    "部分來源素材未能解析，因此無法建立草稿。",
    "Some source assets could not be resolved, so no draft can be created.",
  ],
  "studio.dispatch.viewerNote": [
    "需要操作員或以上權限才能建立草稿。",
    "An operator or higher role is required to create a draft.",
  ],
  "studio.dispatch.created": ["已建立商品草稿。", "Listing draft created."],
  "studio.dispatch.replayed": [
    "此素材組合先前已建立草稿，顯示同一個商品。",
    "These assets already created a draft earlier; the same listing is shown.",
  ],
  "studio.dispatch.openListing": ["開啟商品", "Open the listing"],
  "studio.dispatch.queueEnqueued": [
    "已排入現有上線流程。",
    "Queued into the existing listing pipeline.",
  ],
  "studio.dispatch.queueUnavailable": [
    "草稿已建立，但處理尚未開始；不會顯示為處理中。",
    "The draft exists, but processing has not started; it is never shown as processing.",
  ],
  "studio.dispatch.failed": [
    "未能建立草稿，請重試。",
    "The draft could not be created. Try again.",
  ],
  "studio.dispatch.forbidden": [
    "你沒有權限建立草稿。",
    "You do not have permission to create a draft.",
  ],
  "studio.dispatch.processing": ["處理狀態", "Processing status"],
  "studio.dispatch.readingStatus": [
    "正在讀取處理狀態…",
    "Reading processing status…",
  ],
  "studio.dispatch.checkStatus": ["重新讀取狀態", "Re-read status"],
  "studio.dispatch.noRun": [
    "尚未有可讀取的處理執行。",
    "No processing run is available yet.",
  ],
  "studio.dispatch.runState.queued": ["已排隊", "Queued"],
  "studio.dispatch.runState.running": ["處理中", "Running"],
  "studio.dispatch.runState.succeeded": ["成功", "Succeeded"],
  "studio.dispatch.runState.failed": ["失敗", "Failed"],
  "studio.dispatch.runState.cancelled": ["已取消", "Cancelled"],
  "studio.dispatch.runState.outcome_unknown": ["結果未知", "Outcome unknown"],
  "studio.dispatch.runState.unavailable": ["未能提供", "Unavailable"],

  // -- merchant audit report card (plan Task 11) ---------------------------
  "studio.report.title": ["商戶稽核報告", "Merchant audit report"],
  "studio.report.period": ["期間：{period}", "Period: {period}"],
  "studio.report.periodUnset": [
    "未指定（目前總計）",
    "Not specified (current totals)",
  ],
  "studio.report.attemptsInPeriod": [
    "期內匯出：{attempts} 筆",
    "Export attempts in period: {attempts}",
  ],
  "studio.report.asOf": ["資料截至 {asOf}", "As of {asOf}"],
  "studio.report.scope": ["範圍：工作區", "Scope: workspace"],
  "studio.report.listingsTitle": ["商品狀態", "Listing status"],
  "studio.report.status": ["狀態", "Status"],
  "studio.report.count": ["數量", "Count"],
  "studio.report.qualityTitle": ["品質概況", "Quality summary"],
  "studio.report.qualityLine": [
    "共 {totalListings} 個商品；無缺口 {cleanCount} 個；有缺口 {hasGapsCount} 個；彙總狀態 {projectionState}。",
    "{totalListings} listings; {cleanCount} clean; {hasGapsCount} with gaps; projection {projectionState}.",
  ],
  "studio.report.exportsTitle": ["最近匯出紀錄", "Recent export attempts"],
  "studio.report.attempt": ["匯出紀錄", "Export attempt"],
  "studio.report.rows": ["列數", "Rows"],
  "studio.report.createdAt": ["建立時間", "Created"],
  "studio.report.noExports": ["沒有匯出紀錄。", "No export attempts recorded."],
  "studio.report.unavailable": [
    "未能讀取此部分；未以零代替。",
    "This section could not be read; it is not replaced with zero.",
  ],
  "studio.report.export": ["下載 JSON 匯出", "Download JSON export"],
  "studio.report.exportNeedsSave": [
    "儲存或簽核後才能匯出。",
    "Save or sign off the artifact before exporting.",
  ],
  "studio.report.note": [
    "報告只反映讀取時的記錄；不會寫入商品資料。",
    "The report reflects records at read time only; it never writes listing data.",
  ],
  "studio.report.invalidPayload": [
    "此報告的內容無法顯示；沒有捏造內容。",
    "This report could not be displayed; nothing is invented.",
  ],
  "studio.report.receiptTitle": ["匯出簽章收據", "Export receipt"],
  "studio.report.receiptSigned": [
    "已簽署（HMAC-SHA256，金鑰 {keyId}）；簽章前綴 {signature}…",
    "Signed (HMAC-SHA256, key {keyId}); signature prefix {signature}…",
  ],
  "studio.report.receiptUnsigned": [
    "未簽署：此部署未設定匯出簽署金鑰。",
    "Unsigned: this deployment has no export signing key configured.",
  ],
  "studio.report.receiptNotVerified": [
    "此檢視未驗證簽章；設定簽署金鑰時，JSON 匯出會附上 HMAC 收據。",
    "This preview does not verify a receipt; when a signing key is configured, the JSON export carries the HMAC receipt.",
  ],
  "studio.report.receiptHint": [
    "收據只證明匯出檔由本部署的簽署金鑰產生；不代表外部驗證或核准。",
    "The receipt only shows the export was produced by this deployment's signing key; it is not external verification or approval.",
  ],
  // -- renderer fallbacks ---------------------------------------------------
  "studio.render.fallback": [
    "此步驟的內容未能顯示。",
    "This step's content could not be displayed.",
  ],
  "studio.render.yes": ["是", "Yes"],
  "studio.render.no": ["否", "No"],

  // -- client error surface ------------------------------------------------
  "studio.error.generic": [
    "發生錯誤，請重試。",
    "Something went wrong. Try again.",
  ],
  "studio.error.network": [
    "無法連線至伺服器，請重試。",
    "Could not reach the server. Try again.",
  ],
  "studio.error.auth": [
    "登入狀態已失效，請重新登入。",
    "Your session has expired; sign in again.",
  ],
  "studio.error.forbidden": [
    "你沒有權限執行此操作。",
    "You do not have permission to perform this action.",
  ],
  "studio.error.notFound": [
    "找不到此對話。",
    "This conversation could not be found.",
  ],
  "studio.error.invalidBody": [
    "訊息格式不正確。",
    "The message was not valid.",
  ],
  "studio.error.skillUnavailable": [
    "此技能尚未提供。",
    "This skill is not available.",
  ],
  "studio.error.runInProgress": [
    "此訊息仍在處理中。",
    "This message is still being processed.",
  ],
  "studio.error.runIncomplete": [
    "先前的回覆不完整，請重新載入對話。",
    "The previous reply is incomplete; reload the conversation.",
  ],
  "studio.error.tooManyRequests": [
    "請求過多，請稍後再試。",
    "Too many requests; try again later.",
  ],
  "studio.error.unavailable": [
    "服務暫時無法使用，請重試。",
    "The service is temporarily unavailable. Try again.",
  ],
  "studio.error.retry": ["重試", "Retry"],

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
