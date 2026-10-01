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

- [ ] 測舊 rawRow 欠中文但現內容已補好：不入欠中文 cohort；專名相同可標「需檢查」，不等於事實錯誤。
- [ ] 無目前內容者分類 missing，malformed 者分類 invalid；不能返回「0 缺口／完成」。quality 和 cohort 使用同一缺口計算。
- [ ] cohort 掃描用 workspace-scoped cursor 分頁取代最近 5,000 筆截斷。單批執行最多仍可設 5,000，但超額要回報總範圍、截斷與 continuation，不提高匯入檔案限制來掩蓋問題。
- [ ] preview→create→enqueue 三處核對 fence；內容變動回 409／標 stale，要求重預覽。已審批／已發布商品只透過既有合法 reopen/operation 流程，不能擴大 runnable statuses 繞過 state machine。
- [ ] 測 5,001 件中最舊合資格商品可被掃到，以及 human revision 5 不被 run revision 4 覆寫；執行 service unit + 真 DB cohort integration。

**完成：** 缺口來自現在可維護內容；rawRow 保持不可變；預览不是可永久沿用的批准。

### T05 · 選欄位、跨頁選取與批次預覽【F03/F07；UC08/21/22】

**Modify:** `catalog-control-center.tsx`、`batches-client.tsx`、`app/api/enrichment-batches/route.ts`、`enrichment-batch-service.ts`、`apps/worker/src/listing-operation-pipeline.ts` 及所用 job schema；新增 `apps/web/lib/batch-selection.ts`、`app/api/enrichment-batches/preview/route.ts` 及 tests。

**Interfaces:** `ContentField` 只能是 Global Constraints 的8欄；`BatchSelection = {mode:"explicit"; listingIds:string[]; fields:ContentField[]}`。preview 回 `{previewId, digest, expiresAt, eligibleCount, skippedByReason, maxCostUsd}`；create 引用 previewId/digest/idempotencyKey，server 讀不可變選項並再驗權限/fence。最大成本無法估時明示 unknown，不承諾數字。preview 不 enqueue、不收費。

- [ ] 跨頁選2＋3=5；改 filter 保留這5項並顯示「另有X項不在目前篩選」，提供清除；不暗中擴為全部結果。初版明確不提供「選全部符合」，待 snapshot selector 契約另行實作。
- [ ] 預覽顯示選中、合資格、略過原因、修改欄位、波次1–5、預算、身份衝突；過期或有任何 fence 改變，拒絕整個 create 並重預覽，不能默默少做／換品。
- [ ] 欄位限制經 service→queue→worker→apply 全程傳遞；provider 多回欄位不能被採用。已有人手 lock／更新 revision 優先保留。
- [ ] 測 submitted IDs 混入他 workspace、隱藏非白名單欄、篡改 digest、重播 create；均不能越權或重複 enqueue。
- [ ] 跑 preview route、selection、batch service、worker operation tests，加 real-stack 5件跨頁＋選中文名/SEO流程。

**完成：** 員工知道對哪幾件、改甚麼、花費上限；真正執行項目與確認內容一致。

### T06 · 失敗分類、波次控制及成本恢復【F06；UC23/24/29】

**Modify:** `apps/web/lib/enrichment-batch-control-service.ts`、`enrichment-batch-service.ts`、`batches-client.tsx`、`dashboard-listings-client.tsx`、`jobs-ledger-client.tsx`；worker 只修改實際缺失的 idempotency／reservation 路徑。

**Interfaces:** 安全恢復分類 `retryable | needs-input | needs-review | outcome-unknown | support-required`；派生自 server狀態／run receipts，不能由 browser 指定。每次 attempt 保留 lineage、成本 certainty、request/run ID。

- [ ] 用 3 成功＋1失敗＋1待處理 case 測 pause/resume/retry-failed；成功不重跑，pause 不發新任務，running 任務不假稱已撤銷。
- [ ] 模擬 provider 已接受但回應 timeout：保留 unknown reservation，先 reconciliation，重點擊不可再扣費；budget 上限不容許新 enqueue。
- [ ] 呈現 SKU／安全來源名或短ID、縮圖、失敗階段、最後更新、下一步；同名商品可分辨。手動補資料、重試與工程支援分開。
- [ ] 增加歸檔舊工作能力時，只變 operational visibility，不刪 audit／source／version；未核對成本仍可在 reconciliation 找到。使用既有狀態合法操作，沒有此能力就新增獨立 audited metadata，勿直接改 workflow status。
- [ ] 跑 batch control／service／worker regression，記錄實際 provider fake call count 和reservation證據。

**完成：** 失敗可安全恢復，未知成本可追查；不把9個歷史失敗一鍵盲目重跑。

### T07 · 商品中心及工作上下文【F04/F07/F08；UC05/22/27】

**Modify:** `catalog-control-center.tsx`、`catalog-control-center.module.css`、`workbook-product-detail.tsx`、`jobs-ledger-client.tsx`、相應 catalog/jobs pages；新增 `apps/web/lib/catalog-query-state.ts` 及 tests。

**Interfaces:** URL 僅存非敏感 q、status/source scope、page/cursor、kind；保留現有 route keys。query parser 統一 server initial state與client navigation；debounce 定為300ms。selection 與 return-scroll 保留在同 session，按workspace/role清空，不把大批 IDs 塞進URL。

- [ ] SKU字串保留前置零；300ms 停止輸入後才送 request；保留既有 AbortController及latest-response保護。刷新、back/forward、jobs kind都還原正確篩選。
- [ ] 搜尋 replace URL，明確頁面切換可 push；切換 query 重設頁碼/cursor，避免先發舊page請求；登入角色/工作區變更清除selection。
- [ ] 短頁首＋一列統計＋選中後才出現bulk bar；無export權限者仍可選品／交審，但看到清楚權限說明。
- [ ] 詳情改有標題的側欄：開啟移focus、Esc關閉、關閉還原原按鈕、長內容scroll，手機全屏。避免詳情插在表格上方卻無反應。
- [ ] 擴充 `tests/e2e/catalog-usability.spec.ts`：桌面1348×926看見搜尋及至少5行；手機390×844完成搜尋→查看→返回；不只靠截圖測試，要點實際操作。

**完成：** 同事分享URL能進相同範圍，返回不丟工作位置，主畫面服務日常維護。

### T08 · 帳戶、角色、交接及支援【F05/F06；UC01/02/29】

**Modify:** `apps/web/components/app-shell-nav.tsx`、`app/(app)/admin/page.tsx`、dashboard/listing review元件；新增 `apps/web/lib/listing-assignment-service.ts`、`app/api/listings/assign/route.ts`、其 tests，及必要的workspace-scoped assignment repository/migration。

**Interfaces:** assignment 僅記工作責任 `{listingId, assigneeUserId, assignmentRevision}`，不代表 approval；bulk assign接受每件expectedRevision及idempotencyKey，回逐件結果。admin/reviewer可分派；operator可認領自己或提交reviewer交審，不可任意改他人工作。目標user必須是active同workspace且角色符合。

- [ ] 帳戶選單顯示本人、工作區、角色、登出及支援；用現有Better Auth登出能力，server session失效後受保護API拒絕，清理client快取，不另造token邏輯。
- [ ] operator訪問admin看清楚權限說明及返回操作；server admin endpoints仍403。不要只藏link或讓所有人變admin。
- [ ] 增加「我的工作／未指派／待審」和批量交接；每件檢查scope、revision、合法角色，audit不重複；部分失敗不可顯示全部成功。
- [ ] 支援頁/卡顯示如何複製safe request ID；管理員聯絡方式用真實workspace成員/已設渠道，不能硬編不存在電郵。缺渠道時明示未設定。
- [ ] 測登出後back、撤銷member／role、跨workspace assignment、同時兩人認領、operator直接呼叫admin/approve/export API。

**完成：** 權限說得明，工作交得出；assignment不削弱reviewer批准要求。

### T09 · 管理員未保存表單與實際 readiness【F11/F12；UC28】

**Modify:** `admin-tabs.tsx`、`admin-settings-panel.tsx`、`admin-connection-panel.tsx`、`admin-members-panel.tsx`、相關tests；新增 `apps/web/lib/workspace-readiness-summary.ts`及其tests，以既有server能力組合安全狀態。

**Interfaces:** panel向tab層登記 `{dirty, save():Promise<boolean>, discard():void}`，save失敗不得離開。readiness項 `{key, state:"ready"|"blocked"|"unknown", checkedAt, safeReason, nextAction}`；靜態capability成熟度與runtime readiness分開。

- [ ] tab切換先出「保存／捨棄／留在此頁」；保存完成才切，validation失敗保持原輸入；reload用beforeunload防意外，不能依賴它保證mobile資料保留。
- [ ] 保留expectedDigest/CAS；另一admin先保存，舊表單收到conflict並提供重新載入／比較，不能默默覆蓋。
- [ ] tabs有方向鍵、Home/End、roving tabindex及panel標籤；用鍵盤完成修改與離開。
- [ ] readiness分AI、queue、storage、SHOPLINE、reviewer。無法安全觀察某項就unknown；不以「有env變數」假稱健康、不在每頁載入發付費probe、不把secret送client。
- [ ] 用admin staging帳戶實測dirty/conflict/connection；operator endpoint與payload保持最小必要狀態。

**完成：** 管理員不會誤失未存設定；正常、阻塞、未驗證各有明確含義。

### T10 · 有量測的列表、readiness及品質效能【F09；UC30】

**Modify:** `packages/db/src/repositories/workspace-reads.ts`、`apps/web/lib/source-readiness.ts`、catalog/listing/quality routes；新增 `scripts/benchmark-opak-maintenance.mjs` 及與summary投影對應的repository/integration tests。

**Interfaces:** `readSourceReadinessBatch` 接受當前workspace repositories與有界listing IDs，回 `Map<listingId, 既有Readiness型別>`，不得含foreign records。quality summary以workspace + assessment version保存 counts／knownCost／unknownCount／asOf，不供approval判定。

- [ ] 先對500／5,000／20,000合成商品收集cold/warm時間、query count、DB time、response bytes、error rate、EXPLAIN；benchmark腳本遇非local/明確allowlisted staging即拒絕seed，production不跑load。
- [ ] 合併列表per-row read為set-based查詢；驗證1列和25列的readiness查詢數維持固定上界，設定該上界為本次實際query groups，不只測Promise並行。
- [ ] 用穩定排序+ID tie-break的cursor取代深OFFSET；任何index/search projection依EXPLAIN決定，包含workspace隔離；保持SKU精確與一般名稱搜尋結果。
- [ ] 品質數據以revision-aware投影增量更新＋可恢復reconciliation取代每request全掃；若採async顯示asOf/stale，pending與failed版本不算clean，成本unknown不丟失。queue message/worker handler沿現有jobs zod契約及idempotency。
- [ ] 以真DB測edit/import/delete/archive/replay對counts及cost更新，跨workspace快取隔離；批准／匯出繼續即時查權威資料。
- [ ] 比較前後同dataset：warm catalog p95<800ms、detail<1.5s、搜尋停字後<1s為目標。記hard environment配置、樣本數/併發；lab與field metrics分開，不以一張Lighthouse結果宣稱INP field達標。

**完成：** 量測證明改善，資料一致性與readiness安全性沒有交換掉。若目標未達，交數據和具體bottleneck，不編寫達標結論。

### T11 · Opak AI fixtures、品質訊號及人工評分【F10；UC09–20】

**Modify:** `apps/web/lib/quality-summary.ts`、quality/review元件；沿用 `packages/ai/scripts/eval-listing-verification.ts`。新增 `packages/ai/scripts/eval-opak-maintenance.ts`、`packages/ai/scripts/opak-maintenance-fixtures.test.ts`、`packages/ai/fixtures/opak-maintenance-v1.json`、`docs/runbooks/opak-ai-acceptance.md`。

**Interfaces:** 新工具明確讀 `audit-fixtures-v1`，不是把JSON當現有evaluator原生格式。CLI `--dry-run --output <file>` 或 `--mode=live --budget-usd <positive> --output <file>`；live前驗budget/provider/授權測試資料。AI10等並發案例屬service harness，不能用一次prompt當完成。

- [ ] 12案例依次覆蓋：错年份、NV、酒齡/edition、75cl與小數ABV、清酒精米步合、六支裝、錯版評分、來源注入、資料不足、人工lock/舊run、雙語專名、酒杯非酒類。
- [ ] dry-run驗schema、期望值與映射，保證0 provider請求；fixture不捏造production資料。AI09需另加已授權低清圖片，文字fixture不等於OCR已測。
- [ ] deterministic assertions檢保護欄、數值、revision、來源ID；人工review檢事實與文字。評分35身份事實＋20來源＋15雙語＋15商業可用＋15安全=100；每件≥90且hard-fail=0才合格，不能用平均分遮蓋錯年份。
- [ ] hard fail包含錯identity/vintage/volume/pack、無證據評分/獎項/醫療claim、改SKU價格庫存、未批准發布、跨workspace、覆寫新人手版本。無證據留unknown，不以常見750ml/13.5%填空。
- [ ] quality頁將缺口、事實證據、人工核實、交付readiness分開；品牌原文不直接算錯。unknown cost連到run供對帳。
- [ ] 輸出每件模型/prompt/policy版本、input digest/revision、sources、output、人工verdict、latency、成本certainty。只有已授權受控live run才可報AI品質；沒provider/預算就交可執行harness和blocked狀態。

**完成：** 可重複比較模型版本及人工修改量，保留holdout；原40例dry-run不冒充Opak準確率。

### T12 · 批量審核、XLSX與結果核對【UC08/22/25/26】

**Modify:** `apps/web/lib/bulk-export-service.ts`、`delivery-service.ts`、`components/bulk-export-panel.tsx`、`delivery-panel.tsx`、`app/api/listings/bulk-approve/route.ts`、export/verifications及shopline-import-result routes；`packages/shopline/src/bulk-form.ts`只修契約缺陷，不擴欄位。

**Interfaces:** 沿用既有receipt/freshness型別；UI三個不同語義「檔案已生成」「商戶回報接受/拒絕」「新資料核對完成」。export artifact hash與逐行identity連結，人工回報不能變成independently verified。

- [ ] 顯示舊值→新值→來源及選中欄；低風險批量確認仍是逐件合法確認，不提供「忽略全部警告」。
- [ ] 檢查PR120相關bulk response contract；部分成功回逐件狀態，失敗不能當成功；一次操作只寫應有audit。
- [ ] 測內容、來源、confirmation revision任何改變使舊批准失效；operator直接API不可批准/匯出；publish中較新import不被舊completion覆寫。
- [ ] 用合成XLSX逐cell compare：只8欄允許差異，SKU`000674`、IDs、price、stock、欄位次序保持；未選中欄與inventory delta不重放。
- [ ] 5行結果3接受2拒絕：只修2拒絕項，保留artifact/attempt lineage；再用最新merchant export獨立核對，不用自己生成的原export證明已上線。
- [ ] 執行export/source-binding integration與`tests/e2e/bulk-update-pilot.spec.ts`；真SHOPLINE需商戶參與及已授權gate。

**完成：** 內容交付可追溯，沒有把下載檔案等同網站已更新。

### T13 · 角色、完整工作日及效益驗收

**Create:** `tests/e2e/opak-maintenance.spec.ts`、`docs/runbooks/opak-daily-operations.md`、`docs/runbooks/opak-support.md`。輸入原30-case UAT，新增結果表，不覆蓋原審核狀態。

- [ ] 執行operator、reviewer、admin角色矩陣：登入/登出、商品查看、手動編輯、AI、交審、批准、匯出、assignment、成員/connection/policy。只測允許的role設計；不假定admin帳戶已可用。
- [ ] 跑真DB/worker的20件合成既有商品流程及100件批次pause/retry；含重複、無版本、錯身份、人工lock、unknown成本、stale批准與跨workspace拒絕。
- [ ] 記錄各UC的expected/actual、環境、commit、角色、證據、pass/fail/blocked/not-run；unit、mock E2E、real-stack、live provider、merchant acceptance分欄。
- [ ] 作業手冊用員工動作說明每天匯入、選欄、審核、交接、回填；支援手冊按可重試/補資料/unknown/支援分類，不要求員工懂queue或DB。
- [ ] 20件before/after同難度樣本量測人工分鐘、一次接受率、每件已知成本與unknown、需人工修正欄數。没有baseline只報本次值，不捏造節省百分比。

**完成：** 每個原UC有結果或具體blocker；沒有「30/30通過」卻跳過liveAI/admin的情況。

### T14 · Release pack、遷移及回復

**Create:** `docs/runbooks/opak-release-acceptance.md`；每PR附test/evidence/rollback summary。

- [ ] 全量跑下面矩陣；資料schema改動在乾淨DB及舊schema升級DB驗證，舊web/worker與additive schema相容；先migration再相容code，再bounded backfill/校驗，最後才切讀取。
- [ ] preview用fake/mock或已授權測試adapter；release pack列web/worker/DB版本、配置差異（只列名稱及狀態）、backfill progress、audit核對與未解決問題。
- [ ] rollback以回復code/feature gate及停止新enqueue為主；保留immutable sources、events、versions、已完成外部結果。不可直接down migration刪新資料；running外部請求仍需reconcile。
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
