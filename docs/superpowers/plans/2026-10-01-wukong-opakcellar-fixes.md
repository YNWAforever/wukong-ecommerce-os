# Wukong × Opak Cellar Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本交接預設由 Codex GPT‑6.1 Sol 依序執行；不要求開多個 agent。

**Goal:** 修復正式商品讀取阻塞，讓 Opak 員工完成「既有商品匯入 → 選欄位／批次 → AI 建議 → 人工確認 → 審批 → XLSX → 商戶結果核對」，並可追蹤失敗、成本及工作責任。

**Architecture:** 保留現有 ports/adapters、workspace-scoped repositories、workflow state machine、版本及來源綁定。先診斷 runtime，再接通現有流程；新增功能沿用現有 service／queue／audit，不另建平行商品管理系統。參考來源、可編輯草稿及已核對交付是三種不同資料，UI 與 API 必須清楚區分。

**Tech Stack:** Node ≥24、pnpm 11.7.0、Turborepo、Next.js 16／React 19、TypeScript、plain CSS、Neon Postgres／Drizzle、Better Auth、Cloudflare Worker／Queues／R2、Vitest／Playwright。

**Spec:** `Wukong_OpakCellar_Audit_Evidence_2026-10-01.zip` 內的完整審核 Markdown、30-case UAT CSV、12-case AI fixtures JSON，以及 evidence。執行時將本文件放入 repo `docs/superpowers/plans/2026-10-01-wukong-opakcellar-fixes.md`；證據包在 repo 外解壓，勿提交商戶截圖或紀錄。

## Global Constraints

- 唯一 repo：`https://github.com/YNWAforever/wukong-ecommerce-os`。不是拼錯的 `wukong-ecommerce-o`，也不是 `ui-delight-maker`。
- 審核基準 `dde9e178d9e1f9ca8880618c63104f41fe2fa3be`；當時 production `dpl_4UtLTAFZmKDsyPgPKtvHMBBBbDxm`。這是歷史證據，不是執行時最新狀態。
- 證據 ZIP SHA-256：`030a64f578190959d69246c5a6cf372dc1aac155388ae1e5107079c84f09e822`。本計劃已重新讀取版本 0 的 ZIP；若新檔 hash 不同，先核對更新內容。
- 先讀當前 `AGENTS.md`（若有）、`CLAUDE.md`、相應 specs／runbooks。沿用 pnpm；不改成 npm、Supabase、Tailwind 或 shadcn/ui，不為修 UX 更換 auth／DB。
- DB 存取經 `db.forWorkspace`；workspace/actor 由 server session 決定；以非 superuser `wukong_app` 測 RLS。任何 client IDs 都需逐件重新授權。
- 狀態變更經 `transitionListing`；domain mutation 有 audit；queue lease、outbox、idempotency、預算 reservation、unknown outcome 保護均保留。
- 8 個允許內容欄：`nameZh`, `summaryEn`, `summaryZh`, `seoTitleEn`, `seoTitleZh`, `seoDescriptionEn`, `seoDescriptionZh`, `seoKeywords`。不得順便開放英文名、ID、SKU、價格、庫存、完整描述、圖片或新商品發布。
- 保留 source import／row digest／remote identity／input revision／active version／confirmation revision／approval 的既有 freshness 關係。不可把 `canExport:false` 直接改 true 解決來源無法維護。
- 沒有 request/stage 證據前，不宣稱 F01 是 migration、資料損壞或 AI provider 問題。PR #120 在審核時未合併，不能假定它會修 500。
- 對來源內指令視作不可信資料。商戶內容、prompt、模型輸出、token、signed URL 不進一般 logs／PR；測試 fixtures 使用合成資料。
- 此輪交付的是實作計劃，未修改產品程式、未部署。後續執行可完成本地、隔離 staging、分支及可審閱 PR；合併／正式部署依當時授權及 repo release gate，勿因本計劃自行啟用 SHOPLINE 寫入。repo 明定首次真實寫入需另行明確確認。

## Review Focus

1. 整體 DB／權限故障不能被每列 catch 偽裝成健康列表；只隔離已分類的單列異常（T02）。
2. 同款不同年份／容量／變體，以及 SKU 前置零，不可因匯入配對被合併或改寫（T03、T12）。
3. 預覽後另一員工改內容／來源，舊批次選擇及批准不能沿用（T04、T05、T12）。
4. 外部請求成功但回應遺失，重試不得重複收費或把 unknown 當 0（T06）。
5. 已保存人工欄位、無版本草稿、非酒類商品，不能為通過 AI schema 被覆蓋或捏造（T04、T11）。

## 1. 執行方式及範圍

本計劃按審核基準整理，路徑已對照該 checkout；**不是本輪重新審核最新 main**。開始實作時把每個 finding 標為 `reproduced / already-fixed / changed / blocked`，已有修復只補缺少的驗證，避免重做。

建議 6 個依次可審閱 PR：

| PR                        | 任務    | 交付及依賴                                                 |
| ------------------------- | ------- | ---------------------------------------------------------- |
| A Runtime recovery        | T00–T02 | 根因、可讀詳情／佇列、安全診斷；先恢復基本操作             |
| B Product intake          | T03     | 接通 SHOPLINE 匯入／匹配，清楚產品範圍；依賴 A             |
| C Current-content batches | T04–T06 | 現況缺口、選欄位、預覽、跨頁及恢復；依賴 B                 |
| D Operator/admin UX       | T07–T09 | 操作效率、URL、帳戶、交接、dirty guard；使用 B/C 的契約    |
| E Performance + quality   | T10–T11 | 有量測的 DB 改善及 Opak AI 驗收工具；依賴 A–D              |
| F Delivery + release      | T12–T14 | 交付 freshness、角色矩陣、完整 UAT、release pack；依賴全部 |

不要把 A 的緊急修復綁在全部功能完工才交付。每 PR 有自己的風險、測試及 rollback；不要為湊數拆出不可工作的 scaffold PR。

### 每項共通完成流程

- [ ] 先閱讀指定檔案與既有測試，確認 factory／type／repository 的真實 signature；下述「新增」介面是設計要求，不是聲稱 repo 已存在。
- [ ] 對行為／資料／安全修復加最小 regression test；先確認失敗原因對應問題，再實作及確認通過。純文字／間距改動用實際畫面檢查，毋須建立鏡像單元測試。
- [ ] 執行該任務的 targeted tests；變動 public type 時執行涉及 packages 的 typecheck；資料契約改動加真 DB integration。
- [ ] 更新任務證據、未解決事項及驗收案例，提交一個可理解的 conventional commit。測試失敗不能刪 assertion／skip 來換綠燈。
- [ ] 不因缺某個外部權限停止所有工作：記錄 blocker、完成獨立任務與 staging 驗證；不把 blocked 寫成 passed。

## 2. 任務及檔案

### T00 · 重驗基準與分支，建立執行紀錄

**檔案：** 讀 `package.json`、`CLAUDE.md`、`docs/runbooks/local-development.md`、`docs/runbooks/production-readiness.md`、`playwright.config.ts`；新增 `docs/superpowers/plans/2026-10-01-wukong-fix-status.md`。

**Interfaces:** 輸入 evidence ZIP；輸出 baseline、finding 狀態、PR #120 處理決定及安全環境清單，供全部任務使用。

- [x] 記錄 `git remote -v`、`git status --short`、HEAD、最新 main／部署 SHA。保留使用者未提交修改；必要時從正確 base 建隔離 worktree／`codex/opak-runtime-recovery` 分支。
- [x] 解壓及閱讀所有 12 findings、30 UAT、12 AI fixtures、runtime errors。記錄證據時間；舊數字 520／13／4 不當成現時測試固定值。
- [x] 查 PR #120 現況與 diff；已合併者定位對應 commits，未合併者逐項比對，不盲目 merge/cherry-pick。保留 publish/import race、audit 去重、bulk response validation 等 safeguards。
- [x] 用 repo 宣告的 Node/pnpm 版本，frozen lockfile 安裝；依 local runbook 開 Postgres／MinIO／Mailpit，fake AI + mock SHOPLINE，核對不連 production DB。
- [x] 跑 baseline `pnpm test`、`pnpm typecheck`、`pnpm build`。歷史 116 root + 3,643 package tests 只是比較基線，並非今天已通過。首次 unrestricted web suite 有兩項既有 timeout；相同測試獨立及 bounded suite 通過，詳見 fix-status。

**完成：** 可追溯到程式／部署／DB schema／worker 版本；既有失敗與本次引入失敗分清。無 staging 資料時保留 F01 blocker，不猜根因。

### T01 · 找出 F01 根因並修復【F01；UC03/29】

**Modify:** `apps/web/lib/route-support.ts`、`apps/web/app/api/listings/[id]/route.ts`、`apps/web/app/api/listings/route.ts`；實際根因所在 module 在重現後才加入 PR 範圍。

**Test:** 以上 colocated route tests、`apps/web/lib/route-support.test.ts`；若屬 DB 原因，補相應 `packages/db/src/repositories/*.integration.test.ts`。

**Interfaces:** 保留 `withRouteErrors`／`ApiError` 外部行為，向錯誤回應增加 opaque `requestId`；allowlisted diagnostic stage 為 `session | listing | review | sources | assets | activity | unknown`。server log 只記 requestId、stage、safe code、deployment/commit 及既有允許的 opaque IDs。

- [ ] 在目前授權的正式站只讀重現證據中兩個 listing 和 queue，記 status／request ID；同步核對 schema compatibility、web/worker 版本及錯誤 stage。不要反覆按 retry 當作診斷。
- [x] 在 staging 建去識別最小重現；對 DB／schema問題用真 DB test，不只 mock throw。記錄「何條查詢／何個前提失效」及因果證據。本地專用 Postgres 17 DB，非 cloud staging。
- [x] 加 regression assertion：問題記錄能取得應有內容；非關鍵 stage 失敗能被識別；response/log 不包含 SQL、customer text、credentials。
- [ ] 修真正 cause，避免全域 catch 返回空陣列、強制 schema cast、刪商戶資料或解除 gate。若需 migration，採 additive schema及相容 rollout，附 staging 前後 count/digest。本地 0046 修復及 digest 不變已驗證；正式 migration 未獲授權，仍 blocked。
- [x] 跑 targeted route／repository tests，保存前後 API 證據與 root-cause note。根因仍無證據則標 blocked；診斷能力改進可独立交付但不能寫「500 已修復」。見 `docs/runbooks/opak-runtime-recovery.md`。

**完成：** 根因可重現且 regression 通過；兩個原症狀在對應環境消失，保存、review 基本操作可用；每個錯誤有可查支援編號。

### T02 · 單列錯誤隔離與詳情降級【F01/F06；UC03/04/29】

**Modify:** listing list/detail routes、`apps/web/lib/source-readiness.ts`、`apps/web/components/listing-review-client.tsx`、`apps/web/components/dashboard-listings-client.tsx`。

**Interfaces:** 在既有 row envelope 加 discriminated `readState: "ready" | "blocked"`；blocked row 僅含已授權基本 identity、safe reason、requestId、全部交付動作不可用。詳情以 section-level unavailable 表達非關鍵 activity/preview；critical readiness 缺失表示 unknown/blocked。

- [x] 測 3 正常＋1 malformed row：正常列仍存在，異常列可辨認且不可批准／匯出；auth／workspace／整體 DB 失敗仍是整體錯誤。
- [x] 只捕捉可分類的 per-item data error，不能 blanket `allSettled` 吞所有故障；現有業務 gate 在 mutation endpoint 再驗一次。
- [x] 測 no-active-version 草稿仍可開啟手動輸入；activity 壞了不抹掉內容；來源未知不冒充已驗證。
- [x] 執行 route + component tests，並以 operator/reviewer 在 staging 開正常、異常、無版本三種商品。本地 production build＋Better Auth＋RLS，兩角色 2/2；正式驗收另列 blocked。

**完成：** 看得到失敗項及下一步，壞資料不拖垮其他商品，也不削弱批准條件。

### T03 · 接通既有商品維護及来源配對【F02/F04/F12；UC06/07】

**Modify:** `apps/web/components/listing-intake-tabs.tsx`、`bulk-import-panel.tsx`、`workbook-product-detail.tsx`、`apps/web/lib/bulk-form-import.ts`、`app/api/listings/import/route.ts`、`app/api/workspace/import-setup/route.ts`、`packages/db/src/repositories/workspace-reads.ts`。新增 `apps/web/lib/catalog-maintenance-intent.ts` 及 colocated test；若需要 schema 變更，放既有 migrations 機制，不自行編造 migration number。

**Interfaces:** `MaintenanceIntent = "maintain-existing" | "reference-only" | "new-draft"`；既有 importer 是唯一 source-binding 寫入途徑。catalog 以 source row ID、listing ID、platform identity 表達關係，三者不可互相代替。

- [x] 入口固定三選項：「維護已有 SHOPLINE 商品」「整理參考資料」「建立新商品草稿」；第三項連 `/listings/new`。維護入口先顯示商店／連線 readiness。
- [x] 參考列的「開始維護」帶入候選身份，要求已連商店及最新合法模板；透過既有 importer 建立 binding。缺原始檔／來源太舊時要求重上載，保留 reference，不複製 rawRow 假造新來源。
- [x] 匹配依 store + remote product/variant identity；SKU／名稱只作提示。錯店、不一致年份／容量／pack、重複 ID、歧義變體阻擋或待人工確認；缺少未知資料不預設一致。
- [x] 測同檔重播／回應中断不重複；新來源使舊 approval 失效，source digest 不被覆寫；跨 workspace ID 一律拒絕。
- [x] catalog 顯示來源筆數、草稿數、已綁定商品數及可點擊範圍；提供草稿視圖讓未連結草稿可找到，不把多来源累加為唯一商品。
- [x] 執行 `bulk-form-import`／intake tests、`workspace-reads.integration.test.ts`、`tests/e2e/workbook-import.spec.ts`，完成 20 件合成商品的 import→draft→review。

**完成：** 參考來源仍可追溯；有明確動作可接通維護，沒有名稱自動綁定或直接解除 readonly。

### T04 · 現況缺口與有版本的 cohort【F03/F10；UC18/21/30】

**Modify:** `apps/web/lib/enrichment-batch-service.ts`、`quality-summary.ts`、`packages/db/src/repositories/enrichment-batches.ts`、`platform-products.ts`；新增 `apps/web/lib/current-content-gaps.ts` 及 test。

**Interfaces:** 新 `computeCurrentContentGaps({content, assessmentState})` 接收既有 content 型別的已解析可編輯內容，回傳 `{gaps: BulkFormContentGaps | null, assessmentState: "assessed" | "missing" | "invalid"}`。用既有 working/active version resolution；歷史 rawRow 不再作最新缺口的權威。新增 batch item fence 儲存現有 input revision、active version、source binding revision，沿用其真實型別。

- [x] 測舊 rawRow 欠中文但現內容已補好：不入欠中文 cohort；專名相同可標「需檢查」，不等於事實錯誤。
- [x] 無目前內容者分類 missing，malformed 者分類 invalid；不能返回「0 缺口／完成」。quality 和 cohort 使用同一缺口計算。
- [x] cohort 掃描用 workspace-scoped cursor 分頁取代最近 5,000 筆截斷。單批執行最多仍可設 5,000，但超額要回報總範圍、截斷與 continuation，不提高匯入檔案限制來掩蓋問題。
- [x] preview→create→enqueue 三處核對 fence；內容變動回 409／標 stale，要求重預覽。已審批／已發布商品只透過既有合法 reopen/operation 流程，不能擴大 runnable statuses 繞過 state machine。
- [x] 測 5,001 件中最舊合資格商品可被掃到，以及 human revision 5 不被 run revision 4 覆寫；執行 service unit + 真 DB cohort integration。

**完成：** 缺口來自現在可維護內容；rawRow 保持不可變；預览不是可永久沿用的批准。

### T05 · 選欄位、跨頁選取與批次預覽【F03/F07；UC08/21/22】

**Modify:** `catalog-control-center.tsx`、`batches-client.tsx`、`app/api/enrichment-batches/route.ts`、`enrichment-batch-service.ts`、`apps/worker/src/listing-operation-pipeline.ts` 及所用 job schema；新增 `apps/web/lib/batch-selection.ts`、`app/api/enrichment-batches/preview/route.ts` 及 tests。

**Interfaces:** `ContentField` 只能是 Global Constraints 的8欄；`BatchSelection = {mode:"explicit"; listingIds:string[]; fields:ContentField[]}`。preview 回 `{previewId, digest, expiresAt, eligibleCount, skippedByReason, maxCostUsd}`；create 引用 previewId/digest/idempotencyKey，server 讀不可變選項並再驗權限/fence。最大成本無法估時明示 unknown，不承諾數字。preview 不 enqueue、不收費。

- [x] 跨頁選2＋3=5；改 filter 保留這5項並顯示「另有X項不在目前篩選」，提供清除；不暗中擴為全部結果。初版明確不提供「選全部符合」，待 snapshot selector 契約另行實作。
- [x] 預覽顯示選中、合資格、略過原因、修改欄位、波次1–5、預算、身份衝突；過期或有任何 fence 改變，拒絕整個 create 並重預覽，不能默默少做／換品。
- [x] 欄位限制經 service→queue→worker→apply 全程傳遞；provider 多回欄位不能被採用。已有人手 lock／更新 revision 優先保留。
- [x] 測 submitted IDs 混入他 workspace、隱藏非白名單欄、篡改 digest、重播 create；均不能越權或重複 enqueue。
- [x] 跑 preview route、selection、batch service、worker operation tests，加 real-stack 5件跨頁＋選中文名/SEO流程。

**完成：** 員工知道對哪幾件、改甚麼、花費上限；真正執行項目與確認內容一致。

### T06 · 失敗分類、波次控制及成本恢復【F06；UC23/24/29】

**Modify:** `apps/web/lib/enrichment-batch-control-service.ts`、`enrichment-batch-service.ts`、`batches-client.tsx`、`dashboard-listings-client.tsx`、`jobs-ledger-client.tsx`；worker 只修改實際缺失的 idempotency／reservation 路徑。

**Interfaces:** 安全恢復分類 `retryable | needs-input | needs-review | outcome-unknown | support-required`；派生自 server狀態／run receipts，不能由 browser 指定。每次 attempt 保留 lineage、成本 certainty、request/run ID。

- [x] 用 3 成功＋1失敗＋1待處理 case 測 pause/resume/retry-failed；成功不重跑，pause 不發新任務，running 任務不假稱已撤銷。
- [x] 模擬 provider 已接受但回應 timeout：保留 unknown reservation，先 reconciliation，重點擊不可再扣費；budget 上限不容許新 enqueue。
- [x] 呈現 SKU／安全來源名或短ID、縮圖、失敗階段、最後更新、下一步；同名商品可分辨。手動補資料、重試與工程支援分開。
- [x] 增加歸檔舊工作能力時，只變 operational visibility，不刪 audit／source／version；未核對成本仍可在 reconciliation 找到。使用既有狀態合法操作，沒有此能力就新增獨立 audited metadata，勿直接改 workflow status。
- [x] 跑 batch control／service／worker regression，記錄實際 provider fake call count 和reservation證據。

**完成：** 失敗可安全恢復，未知成本可追查；不把9個歷史失敗一鍵盲目重跑。

### T07 · 商品中心及工作上下文【F04/F07/F08；UC05/22/27】

**Modify:** `catalog-control-center.tsx`、`catalog-control-center.module.css`、`workbook-product-detail.tsx`、`jobs-ledger-client.tsx`、相應 catalog/jobs pages；新增 `apps/web/lib/catalog-query-state.ts` 及 tests。

**Interfaces:** URL 僅存非敏感 q、status/source scope、page/cursor、kind；保留現有 route keys。query parser 統一 server initial state與client navigation；debounce 定為300ms。selection 與 return-scroll 保留在同 session，按workspace/role清空，不把大批 IDs 塞進URL。

- [x] SKU字串保留前置零；300ms 停止輸入後才送 request；保留既有 AbortController及latest-response保護。刷新、back/forward、jobs kind都還原正確篩選。
- [x] 搜尋 replace URL，明確頁面切換可 push；切換 query 重設頁碼/cursor，避免先發舊page請求；登入角色/工作區變更清除selection。
- [x] 短頁首＋一列統計＋選中後才出現bulk bar；無export權限者仍可選品／交審，但看到清楚權限說明。
- [x] 詳情改有標題的側欄：開啟移focus、Esc關閉、關閉還原原按鈕、長內容scroll，手機全屏。避免詳情插在表格上方卻無反應。
- [x] 擴充 `tests/e2e/catalog-usability.spec.ts` 的驗收範圍，以新增隔離 `tests/e2e/opak-catalog-context.spec.ts` 執行：桌面1348×926看見搜尋及至少5行；手機390×844完成搜尋→查看→返回；不只靠截圖測試，要點實際操作。

**完成：** 同事分享URL能進相同範圍，返回不丟工作位置，主畫面服務日常維護。

### T08 · 帳戶、角色、交接及支援【F05/F06；UC01/02/29】

**Modify:** `apps/web/components/app-shell-nav.tsx`、`app/(app)/admin/page.tsx`、dashboard/listing review元件；新增 `apps/web/lib/listing-assignment-service.ts`、`app/api/listings/assign/route.ts`、其 tests，及必要的workspace-scoped assignment repository/migration。

**Interfaces:** assignment 僅記工作責任 `{listingId, assigneeUserId, assignmentRevision}`，不代表 approval；bulk assign接受每件expectedRevision及idempotencyKey，回逐件結果。admin/reviewer可分派；operator可認領自己或提交reviewer交審，不可任意改他人工作。目標user必須是active同workspace且角色符合。

- [x] 帳戶選單顯示本人、工作區、角色、登出及支援；用現有Better Auth登出能力，server session失效後受保護API拒絕，清理client快取，不另造token邏輯。
- [x] operator訪問admin看清楚權限說明及返回操作；server admin endpoints仍403。不要只藏link或讓所有人變admin。
- [x] 增加「我的工作／未指派／待審」和批量交接；每件檢查scope、revision、合法角色，audit不重複；部分失敗不可顯示全部成功。
- [x] 支援頁/卡顯示如何複製safe request ID；管理員聯絡方式用真實workspace成員/已設渠道，不能硬編不存在電郵。缺渠道時明示未設定。
- [x] 測登出後back、撤銷member／role、跨workspace assignment、同時兩人認領、operator直接呼叫admin/approve/export API。

**完成：** 權限說得明，工作交得出；assignment不削弱reviewer批准要求。

### T09 · 管理員未保存表單與實際 readiness【F11/F12；UC28】

**Modify:** `admin-tabs.tsx`、`admin-settings-panel.tsx`、`admin-connection-panel.tsx`、`admin-members-panel.tsx`、相關tests；新增 `apps/web/lib/workspace-readiness-summary.ts`及其tests，以既有server能力組合安全狀態。

**Interfaces:** panel向tab層登記 `{dirty, save():Promise<boolean>, discard():void}`，save失敗不得離開。readiness項 `{key, state:"ready"|"blocked"|"unknown", checkedAt, safeReason, nextAction}`；靜態capability成熟度與runtime readiness分開。

- [x] tab切換先出「保存／捨棄／留在此頁」；保存完成才切，validation失敗保持原輸入；reload用beforeunload防意外，不能依賴它保證mobile資料保留。
- [x] 保留expectedDigest/CAS；另一admin先保存，舊表單收到conflict並提供重新載入／比較，不能默默覆蓋。
- [x] tabs有方向鍵、Home/End、roving tabindex及panel標籤；用鍵盤完成修改與離開。
- [x] readiness分AI、queue、storage、SHOPLINE、reviewer。無法安全觀察某項就unknown；不以「有env變數」假稱健康、不在每頁載入發付費probe、不把secret送client。
- [x] 用本地隔離fake/mock admin帳戶實測dirty/conflict/connection；operator endpoint與payload保持最小必要狀態。authenticated cloud preview／production另記blocked，不能以本地結果當正式驗收。

**完成：** 管理員不會誤失未存設定；正常、阻塞、未驗證各有明確含義。

### T10 · 有量測的列表、readiness及品質效能【F09；UC30】

**Modify:** `packages/db/src/repositories/workspace-reads.ts`、`apps/web/lib/source-readiness.ts`、catalog/listing/quality routes；新增 `scripts/benchmark-opak-maintenance.mjs` 及與summary投影對應的repository/integration tests。

**Interfaces:** `readSourceReadinessBatch` 接受當前workspace repositories與有界listing IDs，回 `Map<listingId, 既有Readiness型別>`，不得含foreign records。quality summary以workspace + assessment version保存 counts／knownCost／unknownCount／asOf，不供approval判定。

- [x] 先對500／5,000／20,000合成商品收集cold/warm時間、query count、DB time、response bytes、error rate、EXPLAIN；441 route samples及126 EXPLAIN，0 error/blocked/cardinality failure。cold是新pool，DB time以EXPLAIN與driver wait分開；見performance-quality runbook。benchmark遇非明確loopback專用DB拒絕seed，production不跑load。
- [x] 合併列表per-row read為set-based查詢；實際PG 1／25／100列的readiness均4 statements（BEGIN、set_config、single owned snapshot、COMMIT），不是Promise並行。E read integration 25／25通過。
- [x] 穩定排序＋PG microsecond＋sourceType／ID tie-break scoped cursor支援catalog/listing/jobs forward/reverse；保留legacy OFFSET bookmarks與current-input名稱／精確SKU。EXPLAIN未證實缺index，沒有新增推測性index。
- [x] 0053 revision-aware投影＋bounded 25項reconciliation；pending／failed不算clean，完整retained known／unknown cost保留；投影不作approval權威。CLI具partial resume及實際command deadline／rollback。
- [x] 真app-role／FORCE RLS DB測current edit／source import／delete／archive／replay／concurrent generation／cost與失敗傳播；quality 20／20通過，批准／匯出保留即時權威查詢。
- [x] exact original500／5,000／20,000 dataset、20warm samples／concurrency2已比較；441相同operations＋63獨立cursor samples。保留v1初始backfill约114秒／一次resume及v2 cursor 1,272.35ms超出800ms的失敗。修正寬CTE後只跑一次controlled v3：504samples／135EXPLAIN，0error／blocked／cardinality failure，21個已配置warm目標通過；quality沒有配置p95目標。20k warm catalog25／deep／SKU／name／detail／ready quality／cursor為126.47／151.26／195.08／150.18／37.10／118.74／81.07ms。source1121／compiled711 hashes與原cohort/input/import/generation指紋不變。保留500 detail、5k catalog1／SKU三項相對D回歸；READY空bounded setup與首次backfill分開。HTTP／browser／field INP分開，見performance-quality runbook。

**完成：** 量測證明改善，資料一致性與readiness安全性沒有交換掉。若目標未達，交數據和具體bottleneck，不編寫達標結論。

### T11 · Opak AI fixtures、品質訊號及人工評分【F10；UC09–20】

**Modify:** `apps/web/lib/quality-summary.ts`、quality/review元件；沿用 `packages/ai/scripts/eval-listing-verification.ts`。新增 `packages/ai/scripts/eval-opak-maintenance.ts`、`packages/ai/scripts/opak-maintenance-fixtures.test.ts`、`packages/ai/fixtures/opak-maintenance-v1.json`、`docs/runbooks/opak-ai-acceptance.md`。

**Interfaces:** 新工具明確讀 `audit-fixtures-v1`，不是把JSON當現有evaluator原生格式。CLI `--dry-run --output <file>` 或 `--mode=live --budget-usd <positive> --output <file>`；live前驗budget/provider/授權測試資料。AI10等並發案例屬service harness，不能用一次prompt當完成。

- [x] audit-fixtures-v1 adapter與12件合成fixtures覆蓋错年份、NV、酒齡/edition、75cl與小數ABV、清酒精米步合、六支裝、錯版評分、來源注入、資料不足、人工lock/舊run、雙語專名、酒杯非酒類；AI07／11為holdout。
- [x] dry-run驗schema、期望值與114 mappings，實際12件、0 provider請求、not_evaluated；original private JSON另經adapter驗證。AI09已授權低清圖片／OCR仍blocked，沒有文字代替圖片的通過宣稱。
- [ ] deterministic assertions檢保護欄、數值、revision、來源ID；人工review檢事實與文字。評分35身份事實＋20來源＋15雙語＋15商業可用＋15安全=100；每件≥90且hard-fail=0才合格，不能用平均分遮蓋錯年份。
- [x] harness hard-fail契約與service／worker人工值及revision保護已驗證；無證據值保留unknown。模型實際identity／來源／claims品質及人工verdict仍需受控live run，不由fake結果推定。
- [x] quality頁四種語義與complete known／unknown cost分開；專名advisory不算事實錯誤，連到實際batch或listing＋run支援核對。實際API／UI／scope及PG契約已通過，production-built browser14／14通過，包括pending進度、refresh及403清除cached counts。
- [x] 已建private per-case版本／digest／revision／sources／output／verdict／latency／cost certainty結果格式與明確live授權／budget／dated pricing／token bounds／unknown stop gate；dry 12件結果not_evaluated。Paid/live、人工評分與圖片acceptance仍blocked。

**完成：** 可重複比較模型版本及人工修改量，保留holdout；原40例dry-run不冒充Opak準確率。

### T12 · 批量審核、XLSX與結果核對【UC08/22/25/26】

**Modify:** `apps/web/lib/bulk-export-service.ts`、`delivery-service.ts`、`components/bulk-export-panel.tsx`、`delivery-panel.tsx`、`app/api/listings/bulk-approve/route.ts`、export/verifications及shopline-import-result routes；`packages/shopline/src/bulk-form.ts`只修契約缺陷，不擴欄位。

**Interfaces:** 沿用既有receipt/freshness型別；UI三個不同語義「檔案已生成」「商戶回報接受/拒絕」「新資料核對完成」。export artifact hash與逐行identity連結，人工回報不能變成independently verified。

- [x] 顯示舊值→新值→來源及選中欄；低風險批量確認仍是逐件合法確認，不提供「忽略全部警告」。actual F20／F5及最新整合候選full24 browser已通過。
- [x] 檢查PR120相關bulk response contract；部分成功回逐件狀態，失敗不能當成功。actual browser重現19項審批產生38個audit；core純驗證＋repository成功CAS後單一writer修正後，actual F20先19後20個審批audit及bindings符合契約，focused110／110、獨立source review通過。PR120仍未合併，沒有假稱它已修正式環境。
- [x] 測內容、來源、confirmation revision任何改變使舊批准失效；operator直接API不可批准/匯出；publish中較新import不被舊completion覆寫。actual F20及source-binding PG通過。
- [x] 用合成XLSX逐cell compare：只8欄允許差異，SKU`000674`、IDs、price、stock、欄位次序保持；未選中欄與inventory delta不重放。actual F5 browser與PG均通過，71cells／name-only mask／blank保留及非blank delta `+0`逐項核對。
- [x] 合成5行結果3接受2拒絕：只修2拒絕項，保留immutable A／B artifact/attempt lineage；actual PG及browser用獨立新合成snapshot核對，不用自己生成的原export證明已上線。最新真merchant export／authenticated origin及商戶sign-off仍blocked。
- [x] 執行export/source-binding actual PG（最終actor-bound候選2／2，63.46秒）與`tests/e2e/bulk-update-pilot.spec.ts`；整合後full24 browser全通過。真SHOPLINE仍需商戶參與及首次真寫入明確確認。

**完成：** 內容交付可追溯，沒有把下載檔案等同網站已更新。

### T13 · 角色、完整工作日及效益驗收

**Create:** `tests/e2e/opak-maintenance.spec.ts`、`docs/runbooks/opak-daily-operations.md`、`docs/runbooks/opak-support.md`。輸入原30-case UAT，新增結果表，不覆蓋原審核狀態。

- [x] 執行隔離Better Auth的operator、reviewer、admin角色矩陣：登入/登出、商品查看、手動編輯、fake AI、交審、批准、匯出、assignment、成員/connection/policy；full24 browser通過。帳戶由本地fixture授權，未推定正式admin已可用。
- [x] 跑真DB/worker的20件合成既有商品流程及100件批次pause/retry；含重複、無版本、錯身份、人工lock、unknown成本、stale批准與跨workspace拒絕。20件actual Queue/browser及100件actual service/worker PG2／2分開；另100件四頁純預覽browser通過，沒有把它當100件AI執行。
- [x] 記錄原UC01–30的expected/actual、環境、source commit、角色、證據、pass/fail/blocked/not-run；历史狀態完整保留，unit／actual PG-worker／real-stack／live provider／merchant-human分欄，不報30／30全部正式通過。
- [x] 作業／支援手冊已交，按員工動作、known retry／補資料／unknown／支援說明每天匯入、選欄、審核、交接、回填。
- [ ] 20件before/after同難度樣本量測人工分鐘、一次接受率、每件已知成本與unknown、需人工修正欄數。没有baseline只報本次值，不捏造節省百分比。

**完成：** 每個原UC有結果或具體blocker；沒有「30/30通過」卻跳過liveAI/admin的情況。

### T14 · Release pack、遷移及回復

**Create:** `docs/runbooks/opak-release-acceptance.md`；每PR附test/evidence/rollback summary。

- [x] 本地全量package/root/types/build/actual PG-worker/full24 browser及既有workbook6／6矩陣通過；乾淨DB及舊schema升級、migration replay、最終indexed0053配exact舊D web/worker3／3已驗證。保留中途失敗，最終PR head遠端CI另列狀態，不能用本地代填。順序為migration→相容code→bounded backfill/校驗→切讀取；正式migration未執行。
- [x] 本地production-built preview用fake/mock；release pack列web/worker/DB版本、配置差異（只列名稱及狀態）、backfill progress、audit核對與未解問題。Cloud READY只證明bundle部署，effective DB／worker／provider flags與authenticated smoke另記blocked，不推定cloud為fake/mock。
- [x] rollback以回復code/feature gate及停止新enqueue為主；保留immutable sources、events、versions、已完成外部結果。最終indexed0053配exact舊D gate3／3通過47.46秒，原180000ms上限與人工／unknown斷言不變；中途timeout原因未確認並保留。不可直接down migration刪新資料；running外部請求仍需reconcile。
- [ ] 在已有正式部署授權時，部署後用operator/reviewer開原問題商品與queue、查500、做非破壞smoke。沒有授權則先把PR、preview及證據做齊，提出具體release決定，不能停在只列計劃。
- [ ] 真商戶pilot按5→20→100件，以每階段hard-fail=0、結果核對完成、無未解成本/身份問題為擴量條件；首次SHOPLINE真寫入遵守repo明確確認gate。

**完成：** 可以定位部署版本、判斷是否成功及安全退回；「code-ready」「production-read-verified」「merchant-pilot-accepted」分開報。

## 3. 驗證指令及證據

以下為審核基準已存在的指令；先讀T00最新scripts。targeted測試可用 `pnpm --filter @wukong/web exec vitest run lib/enrichment-batch-service.test.ts` 類形式，避免誤跑integration未設環境。

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm test:integration
PLAYWRIGHT_E2E=1 pnpm test:e2e
pnpm format:runtime:check
pnpm runtime:forbidden:check
pnpm release-gate:check
pnpm runtime:doctor
pnpm --filter @wukong/ai eval:verification -- --dry-run
```

integration/e2e/runtime命令需要相應runbook環境；不可拿production credentials湊測試。`pnpm lint`在此repo為tsc，不可報作獨立ESLint通過。`audit:verify`依`packages/db/package.json`及release runbook實際flags執行，必須0 missing actions、0 accessible foreign records。新Opak CLI在T11建立後才執行；原dry-run遇tsx IPC EPERM可用相同Node tsx loader備援並記錄，不能改評分跳過案例。

每PR證據需記command、exit code、commit、環境、測試時間、skip原因；安全保存UI截圖、API狀態、request→stage診斷、query比較、逐cell diff。不要把customer dataset複製到public repo。

## 4. Finding 與 UAT 覆蓋

| Finding               | 任務        | 核心驗收                          |
| --------------------- | ----------- | --------------------------------- |
| F01 500               | T01/T02     | UC03/04/29                        |
| F02 參考來源斷路      | T03         | UC06/07                           |
| F03 舊cohort/5000截斷 | T04/T05     | UC18/21/22/30                     |
| F04 統計範圍          | T03/T07     | source/draft/linked各有範圍及入口 |
| F05 角色/登出         | T08         | UC01/02；API越權拒絕              |
| F06 支援及恢復        | T02/T06/T08 | UC23/24/29                        |
| F07 版面/詳情         | T05/T07     | UC05/22；桌面/手機任務            |
| F08 URL               | T07         | UC27                              |
| F09 效能              | T10         | UC30                              |
| F10 品質與成本        | T04/T06/T11 | UC09–20/24                        |
| F11 管理員dirty       | T09         | UC28                              |
| F12 新商品/readiness  | T03/T09     | draft link＋真實runtime狀態       |
| 交付保護              | T12         | UC08/22/25/26                     |
| 全流程/效益           | T13/T14     | UC01–30逐項結果，不冒稱全通過     |

## 5. Codex 每批交付格式

請每完成一批回報：

1. **員工現在能完成甚麼**，附入口與實際行為。
2. Findings已修／原已修／未解，根因證據及核心diff。
3. 本次執行哪些測試、passed/failed/skipped/blocked；附安全artifact。
4. migrations、env名稱、角色、worker配套及回復方法。
5. 下一個依賴任務；如需外部帳戶／預算／正式release確認，交具體可審閱結果及其來源限制。

最終交付repo PR、preview、30-case結果、12-case AI結果（或清楚blocked）、操作與支援runbook、效能前後數據、release/rollback pack。不能只改文案/按鈕，亦不能把未測正式流程寫成已完成。

## 6. 2026-10-02 已授權 staging checkpoint

T00–T14 的 source/local 交付沿用前面的已完成紀錄；production/merchant gates 與下列雲端 rehearsal 分開。使用者已明確授權隔離 synthetic staging/deployment、fake AI/mock SHOPLINE、付費AI呼叫0、雲端預算上限US$5及 production不變。詳見 [staging receipt](../../runbooks/opak-staging-rehearsal-2026-10-02.md) 與 [fix-status](./2026-10-01-wukong-fix-status.md)。

- [x] 新空白 DB/app role/migrations/replay/preflight/FORCE RLS、獨立 cache-disabled Hyperdrive、private R2、preview queues。
- [x] 合成帳戶/tenant隔離、renderer isolation/dry-build；pending credential期間 compute disabled/idle。
- [x] 專用 Preview branch 設定及 Worker 五個必要 Secret 名稱；使用者在 provider dashboard 填 Worker R2 pair，未讀取 secret 值。
- [x] Worker 候選6d8f8ff／version575c6814 實際部署；GET metadata、未簽名/錯誤401、正確HMAC200、Hyperdrive及listing recovery通過；runtime non-bypass/0 ownership/59 FORCE/own1 foreign0。
- [x] 正常 Queue pause、crons=[]及關閉公開入口指令exit0；fresh HEAD404、Neon disabled/idle。remote cron GET及paused flag讀回仍unknown。
- [ ] Web/Worker R2功能及bucket scope、安全mock SMTP、Web部署、authenticated synthetic UAT／Queue消費／scoped audit；Worker health不可代替完整驗收。
- [ ] 保留eaa39b4 CI browser失敗：Admin SPA main空白、invite wait超時、workspace POST尚未開始；本地原case1/1，確切渲染根因未確認。後續ce4cfc9完整CI36956816510成功不構成根因修復證據。
- [ ] Production read驗收、paid/human AI品質、首次真SHOPLINE寫入及商戶5→20→100核對／sign-off仍blocked，不由synthetic通過推定。

Worker 部分 cloud 驗證及停止證據見 [2026-10-02 Worker health receipt](../../runbooks/opak-staging-worker-health-2026-10-02.md)。本次沒有變更app／tests／migration；source與當前文件head的CI須分開記錄。

## 7. Resend staging mail safety — 2026-10-02

Ruling: 使用者指定 Resend；採官方 simulator address＋隔離分支明確 test mode，保留原本 production／一般 Preview 行為。模式若誤放 production 會拒絕連線；不為通過 preflight 填 dummy SMTP 或放寬權限。

- [x] 識別 Preview 繼承的17個非必要 Neon DB/auth alias；只在專用 staging 分支遮蔽，配置明確 auth origin；尚未部署。
- [x] Resend recipient／模式位置／hostname及service preset繞過／URL logging-TLS選項的 RED→GREEN service tests40/40；獨立 review P1已修，final review無剩餘finding。
- [x] Final Web units2274/2274、root143 passed/2 skipped/0 failed、typecheck通過；production/Sensitive secrets未修改，沒有寄信。
- [x] 分支 sender及AUTH_EMAIL_DELIVERY_MODE欄位、manifest／names-only example／[staging runbook](../../runbooks/opak-staging-resend-2026-10-02.md)。
- [ ] AUTH_SMTP_URL Save紀錄、SMTP authentication/sender/quota、實際部署mode／alias／Web-Worker/R2／Queue/UAT/audit；provider名稱及unit不能代替。

Build與新head CI另記fix-status；先前b115 CI成功保留為dated evidence，不推定本次改動已過CI。

## 8. Guarded cloud runtime checkpoint — 2026-10-02

Earlier pending Web/Save/SMTP statements are dated checkpoints, superseded by [cloud Web receipt](../../runbooks/opak-staging-cloud-web-2026-10-02.md). Reviewed source308 fullCI SUCCESS; candidatead3 sole config delta; final READY Preview/auth alias and paired Worker verified.

- [x] User Save, exact branch configuration, server-password/session/role/RLS/logout acceptance with synthetic actors.
- [x] Actual deployed Resend guard plus1 accepted official simulator request; Web R2 read/write/inspection/copy and exact-origin/foreign-key refusal.
- [x] Actual signed Web→Worker→remote Queue5; fake AI10/cost0; current values5 and manual lock1 preserved; scoped audit accessible foreign0.
- [x] Bounded testing/independent watchdogs; paused/cron-ingress command acknowledgements, HEAD404, fresh DB disabled/idle; all failed and successful evidence retained outside Git.
- [ ] Full synthetic approval/source-bound export/result reconciliation/30-case cloud UAT and complete lifecycle audit (missing2 actions); actual Worker R2 read/write-denied/scope proof.
- [ ] Supported cloud browser tool startup failed; no cloud screenshot/browser pass. Production/merchant/paid-human-AI/first-real-write/scale-up gates unchanged.

No new migration/env name. Exact env normalization and isolated CORS correction are reversible configuration actions. Hold/rollback preserves guarded mail mode, data, versions, reservations, audit, artifacts and DLQs; no destructive rollback or production change. Actual cloud billing is unmeasured; zero paid AI and bounded resource windows are separate facts.

## 9. Source-bound cloud delivery — 2026-10-03 HKT

- [x] Five source-import maintained drafts, actual remote fake Queue, masked current values/manual lock preserved.
- [x] Bulk reviewer4+1/failed-only retry, operator403, source/version freshness; A5/Brejected2 and independent497cells; immutableA and independent comparison results.
- [x] ST16 terminal audit missing1 reproduced; atomic per-member ready audit repair with realPG RED→GREEN44/44 and route67/67, release verifier unchanged.
- [ ] Repaired-source cloud scoped lifecycle audit; originalv2 failed receipt retained without backfill. Worker R2 proof/cloud browser/full30-case and production/merchant/human gates remain open.

See [delivery receipt](../../runbooks/opak-staging-delivery-2026-10-03.md) and [cloud case matrix](../../runbooks/opak-cloud-uat-results-2026-10-03.csv). Exact source/build/CI/stop state and remaining limitations are maintained in fix-status; synthetic evidence does not authorize production or true SHOPLINE writes.

## 10. Repaired cloud gate and Worker credential scope — 2026-10-03

- [x] Repaired exact reviewed Preview/current alias; new legitimate export5 and repeat;5 terminal audits once; unchanged release verifier5/5 missing0/foreign0; no AI rerun, watchdog stop144s.
- [x] Actual Worker own R2 read200/exact94-byte hash and foreign bucket HEAD403; original version/hold restored, fresh DB disabled/idle.
- [ ] Worker ObjectRO is **failed**, own canary PUT200. Replace only Worker pair with distinct bucket-limited read-only credentials; re-test must preserve new secret-bound version. No merge/release until denied write proven.
- [ ] Remaining cloud30-case/browser/production/merchant/paid-human gates per [precise matrix](../../runbooks/opak-cloud-uat-results-2026-10-03.csv);3passed/10partial/15blocked/2not-run. Actual billing unmeasured, zero paidAI.

All failed receipts and original A/B audit remain preserved. No migration or production action; exact source e9 CI and later documentation-only head checks are recorded separately in fix-status.

## 11. Corrected Worker Object Read-only verification — 2026-10-03

- [x] User-entered distinct Worker pair uploaded with masked local Wrangler bulk stdin; existing two field names, no key values read/recorded by agent, Web pair unchanged.
- [x] Sixteen offline CLI guards and21 probe contracts; clean normal Worker and probe dry-builds exit0; active/latest precondition verified before upload.
- [x] Actual signed remote proof: invalid signature401; exact94-byte own GET200/hash matched; own PUT403; foreign-bucket metadata HEAD403; no new canary write.
- [x] Preserve corrected versionf0614b8e at100%, both queues paused, cron/ingress disabled, no probe bindings, public HEAD404, independent watchdog normal stop; staging Neon disabled/idle.
- [ ] Production 0046 columns and Hyperdrive BYPASSRLS/cache gates; effective Web DB/authenticated original500 smoke, complete cloud30/browser, paid/human quality, employee-minute and merchant/first-write gates remain open.

## 12. 2026-10-03 synthetic cloud intake/read follow-up

- [x]20exact readonly references,20source-bound maintained drafts and20current editable inputs/SKUs; source-owned AI/pipeline/publish0. Only1manual review version tested. [Receipt](../../runbooks/opak-staging-intake-read-2026-10-03.md).
- [x] Same-byte replay creates0 and does not renew freshness; new source invalidates1approval, stale retry approves0; old source/rows/version/receipt immutable. Historical `approved` remains while authoritative source freshness denies delivery. Existing service verified; no rewrite.
- [x] Operator/reviewer cloud row-only follow-up27/27: healthy incomplete review and no-version inputs remain usable; malformed row blocked/actions denied/support ID correlated. Retain original double-encoded JSON helper failures; `tx.json` fix changes only tooling.
- [x]8unique offline scope guards,13selected source assertions,5owned-ledger assertions; seven watchdog normal stops. Final Neon disabled/idle; correctedWorkerf061/probe0/public404; queues never resumed; paidAI0/realSHOPLINE0.
- [x] Concrete production0046/cache-disable proposal, exact migration hash/CLI flag/rollback and6-hour history metadata prepared. [Proposal](../../runbooks/opak-production-repair-proposal-2026-10-03.md) remains unexecuted.
- [ ] Cloud UI still blocked at Vercel deployment protection despite working headless runtime; cloud matrix4passed/11partial/15blocked/0not-run is not full UAT. Production authority/backup owner, compatible safe-role cutover and remaining human/merchant gates are pending.

- [x] Independent cloud permission-fault16/16/72s and14offline guards: queue/catalog500/noitems when owned SELECT denied; original ACLs restored byte-for-byte then both200, FORCE RLS unchanged; watchdog normal stop/DB disabled. [Receipt](../../runbooks/opak-staging-permission-fault-2026-10-03.json). No new rows, Worker deploy, AI admission or production change; UC29 remains partial for whole-outage/UI.

ST17 is fixed and verified in isolated staging; prior failed evidence stays unchanged. See [executed follow-up](../../runbooks/opak-staging-delivery-2026-10-03.md) and [safe receipt](../../runbooks/opak-staging-worker-r2-retest-2026-10-03.json). No migration, new application env, paidAI, realSHOPLINE or production mutation. PR checks and release gates remain distinct; no conditional merge until the required gates pass.

## 13. 2026-10-03 admin/outage and CI startup follow-up

- [x] T00–T02/ST22 already-fixed, actual disabled-DB API verified: both roles' queue/catalog500, no empty-list success, request-ID body/header correlation15/15 in57.40s. No compute enable/write; downstream auth/query stage and UI are not inferred.
- [x] T09/ST23 already-fixed, cloud admin CAS/readiness29/29 in113.38s: operator/reviewer403, fresh settings audit1, stale409/audit0/no overwrite, five safe readiness states/fakeAI unknown; exact canonical profile restored with second audit. AI20/publish0 unchanged;15 scope guards pass, watchdog normal stop and DB disabled/idle.
- [x] T14/ST24 reproduced→fixed locally: competing TLS49218 allowed fake Worker/Web launch before bind failure. Reserve owned TLS listener before dependencies/readiness; actual regression RED→GREEN, competing owner untouched. Fresh review's Windows detached-descendant deadline issue independently RED→GREEN; both final regressions2/2 and full root142/142+14 cached Turbo tasks pass.
- [x] Preserve original a8 CI attempt1 TLS bind failure and unconfirmed owner; unchanged exact-a8 attempt2 full SUCCESS, including image/Queue/audit/wine. This does not validate the subsequent harness delta. Application files remain e9; isolated Web9dd unchanged.
- [ ] New follow-up head's own CI, authenticated cloud UI, original production500/repair authority/backup owner, paid-human quality, employee-minute and merchant gates remain separate. Cloud matrix4PASS/11PARTIAL/15BLOCKED unchanged. [Behavior/commands/rollback/review evidence](../../runbooks/opak-staging-admin-outage-ci-2026-10-03.md).

Review rulings: leave original conflicting owner unconfirmed; apply actual cloud/production gates independently; retain prior A–F review because no application files changed. Cost if wrong: an unsupported diagnosis or unexecuted gate could be treated as release proof, so no gate is relaxed. Deferred minor: Windows OpenSSL discovery currently assumes the existing Git installation path. No migration/new application env, production mutation, paidAI, trueSHOPLINE or merge.

## 14. 2026-10-03 native auth submission follow-up

- [x] Predecessor8773 exact full CI37106290279 SUCCESS; PR121–126 marked ready for review after their green checkpoints. Conditional merge is still held by production readiness failures.
- [x] ST25/T08 reproduced → fixed locally: pre-hydration native GET puts credential fields in URL. Explicit POST plus real SSR/JavaScript-disabled regression RED→GREEN, five assertions, provider dispatch intercepted.
- [x] Owned synthetic operator credential rotated, old hash rejected, replacement verified, twelve sessions revoked; eight assertions, independent watchdog normal stop, staging DB disabled/idle. Original error retained privately; no production/provider credential changed.
- [x] Auth56/56, full Web2275/2275, root/package command exit0, lint/typecheck14tasks, build8tasks, format/forbidden/machine release checks passed; independent three-file review has no actionable findings. [Receipt and scope limits](../../runbooks/opak-auth-native-submit-2026-10-03.md).
- [ ] This application delta's own exact-head CI and guarded isolated Preview smoke; production0046/cache/runtime-role/recovery ownership/original500 and paid-human/employee-minute/merchant gates remain separate.

Ruling: POST is a safe native fallback, not a no-JavaScript authentication implementation. Cost if wrong: an intercepted security test could be mistaken for successful provider authentication. Keep the existing hydrated APIs and verify actual password sessions independently; no permission or release gate is relaxed.

## 15. Current completion and remaining-gate index — 2026-10-03

- [x] Auth source0b398a7b exact fullCI37111215982 SUCCESS and evidence e094bf39 fullCI37113613076 SUCCESS; Vercel pass. Guarded isolated733 candidate READY/exact alias, sole original deployment-guard delta. The new retained-safeguard checkpoint needs its own source-head CI.
- [x] Cloud v13 31/31 and current v22 32/32; synthetic screenshots reviewed, real roles/logout, row support, readonly identities, mobile/admin dirty/CAS,2448px return±2px, cross-page/refresh exact selection and real job history. Both runs stop safely; v22 watchdog normal stop/DB disabled, AI20/publish0 retained. [Executed receipt](../../runbooks/opak-staging-browser-auth-2026-10-03.md).
- [x] Every unchecked line above audited: common-process checkboxes are a template; sections6–14 are dated receipts with superseding evidence here. Original failures and unknown causes are preserved. A later five-contract PR120 comparison reproduced two missing safeguards; both are now RED→GREEN, as recorded below.
- [x] Open PR inventory120–126 checked.121–126 review-ready and preceding e094 exact-head checks green; the new safeguard source checkpoint requires its own CI.120 remains overlapping draft/CIFAIL36253428550 at Wrangler Queue browser gate; do not claim all open PRs green or merge it blindly. No merge/main change.
- [x] PR120 five-contract comparison: three already-fixed/strengthened, safe Queue diagnostics and in-flight publish/import snapshot race reproduced then fixed. Targeted Web19/19/Worker32/32; full tests Web2283/Worker408/14tasks; lint/typecheck/build pass. Independent review0Critical/0Important/1comment minor deferred. [Commands, rulings and rollback](../../runbooks/opak-retained-safeguards-and-role-handoff-2026-10-03.md).
- [x] Cloudv26 33/33/116.58s: same-context accepted-invite role handoff, dirty workspace Stay/failed Save/Discard/successful Save, old-tenant-only CAS, full second-profile preservation, restore/audit+2 and real three-role logout. Original helper failures retained; correct JSON fixture adapter, zero endpoint relaxation; compute/watchdog stopped. Cloud733 UI proof is separate from the new source fixes.

| Remaining item                | Actual disposition and next concrete gate                                                                                                                                                                                                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01/T00 production cause      | blocked: effective Web DB/session and original two details/queue500 require authenticated read evidence; local missing0046 and whole-DB/permission failure tests are verified, not a unique production cause                                                                             |
| T14 production repair/release | failed readiness:0046 absent, BYPASSRLS/cache-enabled Hyperdrive; pending exact first-stage authority and backup/rollback owner/recoverable point. Then controlled compatible safe-role/schema/code/backfill/audit/smoke sequence; no production action yet                              |
| T11 quality                   | blocked: controlled paid provider/model/pricing/budget/authorizedOCR data and independent human per-case score≥90/hardfail0. Twelve-fixture adapter/dry and service/Worker concurrency/manual/unknown tests are verified; no accuracy claim                                              |
| T13 employee benefit          | blocked: matched20-item before/after human minutes/first acceptance/corrections/known-unknown cost and owner review; no baseline means no savings percentage                                                                                                                             |
| T13/T14 cloud scope           | partial:11PASS/6PARTIAL/13BLOCKED, all30 IDs retained; role handoff/admin workspace-switch, bilingual source search and all six current-gap preview decisions proven. Fuller execution/fault/load and new invitation-delivery journeys remain separate. Local/CI evidence stays separate |
| T14 merchant pilot            | blocked: first real SHOPLINE write's separate final confirmation, approved merchant data/export and5→20→100 reconciliation/hardfail0/sign-off; no expansion or live write                                                                                                                |
| Conditional merge             | held: main auto-deploys while actual production gates fail; PR120 is not green; source593 CI is SUCCESS and subsequent docs-only head needs its own checks                                                                                                                               |

Rulings: retain the native POST security fix on compatible rollback; correct malformed415/private pagination synchronization instead of rewriting product behavior or relaxing assertions; job filter clicks keep existing replace-history semantics. Cost if wrong: a helper artifact could be treated as a diagnosed product failure or a synthetic result as production/merchant acceptance. Original no-JavaScript scope, failure receipts,2px tolerance and all release boundaries remain explicit. No migration/new env/Worker deployment/production change/paidAI/realSHOPLINE.

## 2026-10-03 bilingual catalog search follow-up

- [x] ST26/T03–T07/UC05 reproduced: Chinese-first display title hides current English from catalog search; cloud733/v27 and actual repository query return0.
- [x] Corrected actual PostgreSQL RED3/3 → GREEN18/18; current human/locked title authority, readonly references, foreign workspace/import exclusion, leading-zero source SKU, literal search, >5000 pagination, cursor and response boundaries retained.
- [x] Full pnpm test14tasks/Web2283, lint/typecheck14tasks each, build8tasks; independent review0Critical/0Important/0Minor. No migration/env/dependency.
- [x] Earlier674 fullCI37119472547 SUCCESS and six repair PR checks green at refresh; PR120 remains draft/failed. No merge/main change.
- [x] Source593 exact CI and guardedc23/cloud UC05/current-gap acceptance completed; see2026-10-04 supplement. Original failedv27 and cleanup receipts remain unchanged.
- [ ] Actual production readiness/authority/recovery/original500, paid/human quality/employee benefit and first merchant write/pilot gates remain open; main auto-deploy merge held.

[Root cause, exact verification, review rulings and rollback](../../runbooks/opak-bilingual-catalog-search-2026-10-03.md). Separate legacy listing API search and deployed latency are outside this reviewed catalog delta; no wider search/production acceptance inferred.

## 2026-10-04 HKT verified release supplement

- [x] Source593c5283 exact fullCI37132320997 SUCCESS; source/local checks and independent catalog review remain valid. Subsequent docs-only commit must complete its own checks. PR121–126 green/CLEAN at16:22:43Z; PR120 draft/failed remains distinct.
- [x] Guardedc23 exact593 tree except branch deployment guard; READYdpl_8eC5Xw5yU1zTZ8mXPF1HWvjbvYg8/alias verified. Cloudv31 behavior39/39 proves UC05 source-qualified bilingual search and UC21 all six current-gap decisions; no batch creation or AI execution. Current matrix11PASS/6PARTIAL/13BLOCKED/all30 IDs.
- [x] Required preview audit+2/prior252 hashes preserved; other ten domain snapshots unchanged/AI20/publish0/batches2. Logout200/401; first compute-disable timeout retained, separate cleanup disabled/idle0.25CU verified and8-minute watchdog normal stop. Screenshot visually reviewed outside Git.
- [x] Worker candidatefcf96cda inactive0% from593 artifact/config,11/11 upload checks. Active correctedf061 stays100%/same deployment; secrets/queues/cron/ingress unchanged. No candidate runtime/R2/Queue pass inferred. All failed upload/browser/cleanup receipts retained.
- [ ] Production0046/owner-BYPASSRLS/cache readiness, effective Web/original500, exact production repair authority and named recovery owner/confirmed recoverable point remain incomplete. Conditional main auto-deploy merge held.
- [ ] Paid/human12-case quality, matched20-item employee benefit, fuller cloud execution/fault/load/new-invite criteria and first realSHOPLINE/5→20→100 merchant gates remain open; synthetic passes do not satisfy them.

[Executed behavior, commands, safe receipt, review scope and compatible rollback](../../runbooks/opak-bilingual-catalog-search-2026-10-03.md). No migration/new app env/dependency/provider key/paidAI/realSHOPLINE/production mutation. Actual cloud billing remains unmeasured. Earlier pending lines are dated evidence superseded only within these explicitly executed scopes.

## 2026-10-04 HKT reviewed Worker and hundred-selection checkpoint

- [x] Exact reviewed593 Workerfcf now100% in isolated staging; signed health12/12/142.695s, domain11 unchanged, non-bypass role/FORCE59/59/foreign0. Earlier inactive/f061 checkpoint is historical.
- [x] Temporary current-config R2 probe ownGET200/hash/PUT403/foreign metadata403; exactfcf restored with corrected five secret names/no probe vars. First placement-marker failure preserved; generated-config4 and probe11+cleanup10 guards pass. No secret/migration/app source change.
- [x] One normal source import100/current manual facts and locks100; actual four-page/refresh/one-field exact preview17/17. Header adapter RED1→GREEN1 and invalid filter corrected only in tooling; no duplicate import or relaxed gate.
- [x] Exactly first5 durable admissions and same-key replay; original expectation failure retained. Existing partial-copy protection correctly retains5needs-info candidates; current Worker16/16 and scoped cloud reconciliation9/9/current100 unchanged. Only original5 resumed;95remain unstarted/0queued/failed; no100 Queue pass claimed.
- [x] Real logout/queue+cron-ingress hold acknowledgements, normal independent watchdogs and fresh public404/compute disabled-idle0.25 readback; actual billing unmeasured, paidAI0/realSHOPLINE0.
- [ ] Original reviewer UC22 five-item export/filter/digest criterion on qualified100, injected cloud pause/failed-only/unknown/load/new invitation criteria; matrix remains11PASS/6PARTIAL/13BLOCKED.
- [ ] Exact production authority/recovery/role/schema/cache/effective Web/original500; paid-human quality, employee minutes and first realSHOPLINE/merchant gates. Conditional merge still held; PR120 is not green.

[Executed behavior, roots, commands, receipt and compatible hold/rollback](../../runbooks/opak-reviewed-worker-cloud-gates-2026-10-04.md). Source593 and prior docs d86 exact CIs passed; this new docs-only head needs its own checks. No product code fix, migration, app env, provider secret or production change inferred from evidence-helper failures.

## 2026-10-04 HKT original UC22 reviewer checkpoint

- [x] Original UC22 on100 synthetic approved current fixture: reviewer2+3 across pages, changed filter, exact5 preview; actual digest movement revokes attestation/preview without reload; server old-preview409; explicit current five re-review/confirmation yields new preview5.20/20/132.811s, AI/publish/artifacts unchanged.
- [x] Normal manual review/confirmation/bulk approval fixture100; operator403. Qualification helper status/listingStatus failure preserved; independent readback8/8/7,100cells/prior5inputs-candidates/AI30/publish0. No duplicate approval or missing byte-hash claim.
- [x] Original old batch95 unstarted cancelled through service; only5 re-reviewed on fresh source. Other95 approvals historical after refresh; no100 Queue/merchant success claim. Sessions/queues/ingress/compute held; currentfcf100/source593/HEAD404/idle0.25 independently read back.
- [x] Cloud matrix updated only UC22:12PASS/5PARTIAL/13BLOCKED/all30.
- [ ] Latest docs head ownCI; c3 attempt1 website dispatch failure retained, unchanged-head reproduction pending; no unique underlying ingress cause or source fix claimed.
- [ ] UC03/06/23/24/29 partial; paid-human UC09–20 and load/employee UC30 blocked. Production authority/recovery/role/schema/cache/effective Web/original500 and separate merchant first-write gates remain open. Conditional merge held.

[Commands, exact criteria, failure disposition, safe receipt and hold/rollback](../../runbooks/opak-uc22-reviewer-cloud-2026-10-04.md). Prior checkpoints remain dated; this supersedes only the old UC22 pending criterion, not other release gates.

## 2026-10-04 HKT UC23 remote failure checkpoint

- [x] Real isolated Queue3success/1knownfailure/1pending; normalUI pause202, paused advance0 and retry409 with unchanged runs. Same-batch refresh resolves expected stale-control409; Resume202 and failed-only one attempt2/idempotent replay; final5success/6total including old failure.30/30 completion; original3success ledger/run values, older workspace records, manual locks and source cells retained;11fake ledger records cost0/publish0.
- [x] All11 windows normal watchdog stops/cleanup acknowledgements; reviewedfcf restored100%/no probe vars/public404/compute disabled-idle0.25. No paidAI/realSHOPLINE/production change; billing unmeasured; remote paused/cron flags independently unavailable.
- [x] ST27/T06 reproduced paused label omitted from shared state mapper; bilingual rendered regression RED2→GREEN17/17, fulltest14tasks/Web2285.
- [x] Cloud matrix changes only UC23 to passed:13PASS/4PARTIAL/13BLOCKED/all30. Earlier failed dispatch/proxy-shape/invalid-output/support/stale-CAS receipts remain dated evidence.
- [ ] New label candidate lint14/typecheck14/build8 and automated static checks passed; exact CI/protected preview and final release pack pending at this precommit checkpoint.
- [ ] UC03/06/24/29 partial; paid-human UC09–20/load-employee UC30 blocked. Production exact authority/recovery/schema/role/cache/effective Web/original500 and merchant first-write/pilot gates remain open. Conditional main merge held.

[Behavior, root classifications, commands, safe receipts and rollback](../../runbooks/opak-uc23-cloud-pause-retry-2026-10-04.md). Historical checkpoints remain unchanged.
