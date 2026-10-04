# Opak 維護修復 release／rollback pack

日期：2026-10-01。此文件記錄可審閱的候選版本與放行條件；首次 SHOPLINE 真寫入仍須另有明確確認。原商戶附件、workbooks、screenshots、模型輸出及 connection strings 留在 repo 外的私人證據位置。

## 三個互相獨立的結果

| 結果                     | 現況                                                                                             | 放行所需證據                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| code-ready               | source593c5283 完整 CI37132320997 SUCCESS；本輪後續 docs-only head 的 exact-head checks 另行核對 | 終態候選SHA／CI／preview及其後docs-only checks見fix-status與PR；歷史通過不代替最新check                                          |
| production-read-verified | blocked                                                                                          | 正式 web 實際使用的 DB/schema 識別、部署一致性、已授權 operator/reviewer 對原詳情／queue 的非破壞 smoke、安全 request/stage 證據 |
| merchant-pilot-accepted  | blocked                                                                                          | 首次真寫入的獨立確認、5 → 20 → 100 各階段結果核對、最新已授權 merchant export 的獨立逐欄核對、商戶簽署                           |

READY preview 不等於已登入驗收；fake AI 成功不等於模型準確；下載成功不等於 SHOPLINE 已接受。不得將部分結果合併成「全通過」。每個 UC 的歷史結果與本輪結果見 [30-case 結果表](./opak-uat-results-2026-10-01.md)。

Dated2026-10-03 intake checkpoint (superseded within the executed scopes below): [synthetic cloud intake/read evidence](./opak-staging-intake-read-2026-10-03.md) verifies20reference/draft/current-input bindings, source replay/freshness and both-role row resilience. The current cloud matrix is4passed/11partial/15blocked/0not-run. Headless runtime works but direct app UI remains behind Vercel deployment protection. [The first production repair proposal](./opak-production-repair-proposal-2026-10-03.md) is prepared for explicit authority and backup/rollback ownership; no production change or release sign-off occurred.

## 版本與部署識別

| 部件                     | 核對到的識別                                                                                                                                                          | 限制                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 審核 baseline／當時 main | `dde9e178d9e1f9ca8880618c63104f41fe2fa3be`                                                                                                                            | 用作比較，不要求退回                                                                                                                                              |
| production web           | 2026-10-03 read-only refresh：Vercel `dpl_7qVNQ191tqXME3uT7rWmZ4ssA92d` READY；上述 main SHA                                                                          | 未完成 authenticated 原問題 smoke；release 前需重查 alias 與 SHA                                                                                                  |
| production worker        | Current deployment `01bb6ad8-6227-49b9-b903-43ccb22488ee`; version `6842b51c-95ce-4bdf-989d-36a645be8f59`, 100%; BUILD_SHA `3ca5b99520e056bda99c0efbe87192e619026f04` | 2026-10-02 status refresh; configured Hyperdrive uses BYPASSRLS origin and enabled query cache. See [cloud refresh](./opak-cloud-readonly-refresh-2026-10-02.md). |
| production DB            | Neon project `weathered-lake-51694428`；main/default branch `br-twilight-meadow-at9qky4q`；`neondb`，PG 17.11                                                         | read-only metadata 顯示缺少既有 0046 source-binding 欄／FK；effective web connection 尚未確認                                                                     |
| A                        | [PR #121](https://github.com/YNWAforever/wukong-ecommerce-os/pull/121)；`1707ab17c8527973ec4047b55a008ffd1863998a`                                                    | review-ready，未合併                                                                                                                                              |
| B                        | [PR #122](https://github.com/YNWAforever/wukong-ecommerce-os/pull/122)；`a181cda3d163b2f8825bef1582839a99aca96429`                                                    | review-ready，stacked on A                                                                                                                                        |
| C                        | [PR #123](https://github.com/YNWAforever/wukong-ecommerce-os/pull/123)；`ee26897fdd2728b685ec224c82e50ce4699353db`                                                    | review-ready，stacked on B                                                                                                                                        |
| D                        | [PR #124](https://github.com/YNWAforever/wukong-ecommerce-os/pull/124)；`b8fe92a3273841dd2a7857905f9ac796cc5200fa`                                                    | 完整 CI `36874983297` SUCCESS；exact-head preview `dpl_BcBsVsiHuuW6D8kgEkhKxXH5Szo4` READY                                                                        |
| E／F                     | 最終候選與 CI／preview 更新於 [fix-status](../superpowers/plans/2026-10-01-wukong-fix-status.md)                                                                      | 本表不以中途 source checkpoint 冒充最終候選                                                                                                                       |

production metadata 是本輪已核對到的快照，正式 release 前必須刷新。最新read-only inventory是54張public regular tables，其中44張RLS全44張FORCE RLS，零張RLS未FORCE；54不是FORCE-RLS數量。缺 0046 已在隔離 DB 重現兩條 route 的 500，補回後正常；這不證明所有正式 500 都只有同一原因，也不證明未合併的PR #120 已修正式環境。全 DB／權限故障仍回錯誤，不回空列表。

## 配置差異：只記名稱與狀態

| 名稱                                                                              | 本地／CI evidence                                                   | 正式 release 要求                                                                           |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `DATABASE_URL`／Hyperdrive runtime connection                                     | 專用 loopback `opak_fixes_*` DB；non-superuser、non-bypass app role | runtime role 與 migration role 分離；確認 RLS workspace 設定；禁止 admin role 進 web/worker |
| `DATABASE_ADMIN_URL`                                                              | 只用於本地／CI 隔離 migration fixture                               | 只給受控 migration job；不複製值到 logs／PR                                                 |
| `AI_PROVIDER`                                                                     | `fake`                                                              | 已批准的現有 provider 配置；本輪沒有 paid/live 預算授權                                     |
| `SHOPLINE_ADAPTER`                                                                | `mock`                                                              | 未過首次真寫入 gate 時保持 `disabled`                                                       |
| `SHOPLINE_PUBLISH_ENABLED`                                                        | `false`                                                             | 首次真寫入另有明確確認；此 pack 不切換                                                      |
| `AUTH_SECRET`、`QUEUE_INGRESS_SECRET`、`SHOPLINE_TOKEN_ENCRYPTION_KEY`            | synthetic local 值；安全日誌會遮蔽                                  | 保留現有 custody／rotation owner；不新增或公開 secret                                       |
| `S3_*`                                                                            | 私人 MinIO fixture；runtime HTTPS TLS proxy                         | 確認 private bucket 與 scoped credentials；保留 artifacts                                   |
| `WUKONG_OPAK_E2E`、`WUKONG_OPAK_INTEGRATION`、`PLAYWRIGHT_E2E`、`TEST_DATABASE_*` | 顯式 local/CI opt-in，exact DB guard                                | 不用作 production 開關、不注入正式 runtime                                                  |

E/F 不新增必要的 production secret。模型 eval 的 live flags、授權資料、budget、dated pricing/model 證據見 [AI acceptance](./opak-ai-acceptance.md)；dry-run `not_evaluated` 不可填成品質 pass。

## Migration、投影與 read cutover

新增 schema 是 additive：C `0049_batch_current_content_fences.sql`、`0050_batch_selection_previews.sql`、`0051_batch_operational_archive.sql`；D `0052_listing_assignments.sql`；E `0053_quality_projection.sql`。A 修復核對既有 `0046_listing_version_source_binding.sql` 的實際應用狀態；`0047/0048` 是 baseline 已存在的 auth migrations。F 沒有新 migration。

1. 先記錄目標 web/worker SHA、DB branch/schema inventory、app role、backup/restore owner。取得當時 release 所需授權；本輪不自行在 production 執行 migration。
2. 在乾淨隔離 DB 及舊 schema 升級 DB 執行正常 migration runner；重播必須安全。核對 composite workspace FK、FORCE RLS、non-bypass app role、exact tenant-table inventory。沒有欄位時停止，不能靠 catch 消除錯誤。
3. 先套用 additive schema，再部署相容 code。本輪實際舊 D `b8fe92a3273841dd2a7857905f9ac796cc5200fa` web／worker 對初版0053的隔離相容性 gate 3／3通過（58.21秒）；最終indexed schema的獨立gate亦3／3通過（47.46秒），保留中途timeout及其未確認原因，詳見下節。這個特定 rollback candidate 的證據不代表任何更舊 SHA 都能處理新的 Queue／preview 契約。
4. 對 quality 投影執行有界 reconciliation。CLI `quality:backfill` 目前只接受明確 loopback、專用 `opak_fixes_*`、app-role 及 workspace；每 batch 最多 25，總 batches／時間有上限，部分完成 exit 2，可續跑。不可用修改 guard 的方式把本地 CLI 指向 production。staging／production backfill 需要另有授權的受控 runner。
5. 保留每個 workspace 的 assessment version、pending/failed、asOf、generation progress 與 known/unknown cost 校驗。pending/failed 不算 clean；成本包含 retained runs，archive 不抹帳。批准／匯出仍查當前權威資料，不能用投影判斷。
6. 切讀取後做 operator/reviewer 非破壞 smoke，再按 exact scope 跑 `audit:verify`；missing actions 必須 0、accessible foreign records 必須 0。未做的目標環境 audit 不能借用本地結果代填。

## 舊 code 對 additive schema 的實際相容性

專用 loopback DB `opak_fixes_compatibility_20261002` 先以正常現行 E migration runner 套至 0053。獨立 preflight 確認新兩張 quality tables、七個 triggers、FORCE RLS 及既有 ready assessment。隔離 checkout 切至 exact D SHA，重新 build 舊 DB／worker dependency closure；13個實際 source 檔與 Git blob（Windows CRLF正規化後）相同，六個 runtime package realpaths 留在該 checkout，舊 DB 不含 E quality/cost API。

Private 相容性 fixture 沿用已提交 F100 的實際 importer／batch/control／Cloudflare runtime／worker 流程；只替換 guard 的新專用 DB 名稱及兩個 E-only cost 方法，以 scoped non-bypass SQL 保留同一 known／NULL／lineage 斷言。先驗證 upgraded schema 後，舊 migration loader 只指向私人空目錄，沒有重播／降級舊 DDL，也沒有把 E runtime 混入舊 code。新增舊 HTTP detail owned200／human locked current title與description、foreign404，並驗证舊 worker 寫入會推進新 quality generation。

初版0053實際3／3通過：三個 worker 成功檢查的 generation 至少增加4；保留99 versions、101 pipeline runs、201 AI ledger observations、996 audit events、101 batch attempts及一筆 unknown cost；archive／restore後 retained known／unknown仍完整。Postflight 的完整 table inventory、schema／FK／FORCE RLS／七 triggers與既有 ready sample fingerprint不變，沒有 active／idle-in-transaction app session。本證據及 private fixture／source/dist hashes 留在 ignored evidence，沒有 production mutation。這是特定 code／schema 的可執行相容性，沒有聲稱未完成階段滿足完整 publish audit。

最終0053另用正常migration runner加入workspace/live-listing FK支持index。第一輪indexed gate保留1／3通過、196.72秒與原180000ms lifecycle timeout；當時已成功86個pipeline，但未達manual-summary階段，不能以該輪證明完整相容。原因未確認，不將其歸咎於index、pool或主機負載。

停止所有本輪其他build/test/browser服務後，使用同一舊D、同一indexed schema、原三個case／100件／每wave5件／20個人工編輯及原180000ms上限，單次被動診斷v3實際3／3通過：47.46秒total、42.02秒tests、exit0。只加stage時間、原生driver debug/application_name及有界readonly backend samples；沒有替換Query/then/transaction/serializer，沒有reset、down migration、reconcile、盲重試unknown或產品修改。19個forward waves及20個manual summaries完成，owned detail200、foreign404；99versions／101pipelines／201AI rows／996audit events／101attempts完整，known0、unknown run1與其actual pipeline/batch及unknown reservation1保留。

42個app backend samples沒有觀察到Lock wait，最大sampled active query age5.1ms；worker execute p95/max332/403ms、advance p95/max758ms。Sparse samples沒有量到pool wait或完整SQL end，不能解釋前一輪timeout的唯一原因。indexed DDL/schema／FORCE RLS／七invoker triggers／ready sample全部保持，app active/idle-in-transaction最後0。還原exact E `ea827e081ba3c98797c6f468818051e9540fbdf7`，fresh worker closure7／7退出0、tracked clean、原四個local logs保留，所有owned commands已結束。Private `old-d-compatibility-v3/final-note.json` SHA256 `a4230252f3c82a850d2de8b9f847fd135cee30eaefc73a7885ddab5d2352917e`；retained v2 timeout原因仍未確認。

## 本輪 evidence 與尚未完成的放行條件

本地 fake/mock 已有 source/version/manual lock、跨頁 5,001 項、10 件並發、unknown outcome／reservation、pause／failed-only retry、XLSX 71 cells、5 行 3 接受／2 拒絕修復 lineage、actual RLS PG 的獨立證據。source候選F `d70e1a4d05ff2b5922ae9fd12e3c6f6c2241b6b4`的production-built full24 browser通過（4.3分鐘），包含20件actual Queue／審批audit19→20、5行A／B拒絕修復及100件四頁純preview。100件actual service／worker recovery另外PG2／2，不能把preview當100件AI執行。既有workbook browser consumer的舊export及單件bulk_form requests缺新fields／preview hash；test-only補齊同actor兩步preview／generate後，整份workbook6／6通過（50.8秒），原readonly拒絕及零audit/artifact/attempt副作用斷言不變。先前400及cold signin失敗證據保留，沒有以它們冒充runtime權限缺陷。確切命令、結果、SHA、失敗紀錄及最新狀態以 fix-status 為準。

E source `ea827e081ba3c98797c6f468818051e9540fbdf7`完整CI `36906156935` SUCCESS，對應READY preview `dpl_58Auk7p8hoMsCbZMFQ4fdkg1pySY`；F上述source READY preview `dpl_8XsQR9Yo4RLRexoHNcjy7Ky69HAh`。READY只證明bundle部署完成；本輪沒有確認cloud preview的effective DB／worker／provider flags，也沒有以READY替代authenticated acceptance。本地CI fake/mock配置不推定為cloud配置。

2026-10-01 20:12 UTC終態收據：E `a3c1109faa9384c9fa5d15af0be488dfdb6ce5d0` [完整CI36914479048 SUCCESS](https://github.com/YNWAforever/wukong-ecommerce-os/actions/runs/36914479048)／[exact-head READY](https://wukong-ecommerce-qouahym2p-ynwaforevers-projects.vercel.app)；F `9540a0bf354a5233e0e9ee84e54e28b641c8b5ae` [完整CI36916917375 SUCCESS](https://github.com/YNWAforever/wukong-ecommerce-os/actions/runs/36916917375)／[exact-head READY](https://wukong-ecommerce-3nf1uuto9-ynwaforevers-projects.vercel.app)。F包含3950unit passes／1existing asset skip、root140、types14／build8、generic PG990passes／69gated skips（專用F5／F100已另外實跑）、browser3／17／product-shot4／combined31passes30skips／wine9；audit verifier成功且accessible foreign0。這些終態取代較早CI pending checkpoint；local full24、workbook6與100件worker的scope仍分開。後續收據／UAT metadata提交只有文件差異，當前docs-only head checks見PR，不把未命名的未來head算已驗證。

效能 baseline 與 after 使用同 500／5,000／20,000 fixture IDs、samples/concurrency/host 配置。保留v2 cursor未達800ms的1,272.35ms；修正無搜尋寬CTE後單次controlled v3 504samples／135EXPLAIN、0errors、21 configured warm targets通過，20k cursor81.07ms。Quality沒有配置p95門檻，三項小規模baseline回歸及約114秒首次backfill仍記錄。route-factory時間不等於HTTP／browser field metrics。20件員工人工分鐘、一次商業接受率、每件修改欄數沒有可比較的人工baseline，因此不能報節省百分比。fake已知成本0與刻意注入unknown分開記。

仍 blocked：authenticated cloud／production smoke、effective web DB connection、worker runtime-role/cache remediation、production migration/deployment authorization、受控 paid/live AI 與人工評分、已授權低清圖片、真商戶最新 export／origin、首次真寫入及 merchant 5 → 20 → 100 sign-off。這些 gate 不妨礙完成可審閱 source／PR／preview；也不能由 synthetic 通過推定已放行。

## 回復與停止擴量

先停止新 enqueue／advance，暫停受影響批次及外部寫入。記錄已開始或 unknown 的外部請求及 reservation；先對帳，不能盲目重試。web/worker 回復必須選相容的一組 SHA，front-end XLSX preview 與兩個 bulk_form API consumer 一起回復；舊 client 缺 fields/hash 會 fail closed 400，重新整理後再操作。

保留新 tables、immutable sources、input revisions、versions、audit、Queue/DLQ、artifacts、A/B attempts、receipt corrections、accepted 結果與成本帳。禁止 destructive down migration、purge 或重寫歷史來模擬回復。停用投影讀取／回復相容 code 不會回復商戶內容。

商戶內容回復按 [UAT rollout 的 restoration procedure](./opak-uat-rollout.md)：用保留的原始 source 與新的已授權 merchant export 核對，製作只回復目標內容而保留當前 protected fields 的 exact artifact，另取得商戶對該 bytes／scope／differences 的明確授權，再逐件 reconcile。

## 2026-10-03 remaining-contract follow-up

[Executed safeguard/handoff receipt](./opak-retained-safeguards-and-role-handoff-2026-10-03.md): PR120's five retained contracts compared; three already present, safe Queue diagnostics and publish/import update race reproduced then fixed. Local target suites19/19+32/32; full tests Web2283/Worker408/fourteen tasks, lint/typecheck/build passed, independent review0Critical/0Important/one comment minor deferred. The preceding e094 exact fullCI37113613076 succeeded; this new source checkpoint needs its own checks.

Cloud733 v26 separately passed33/33/116.58s for same-context accepted-invite role handoff and admin dirty workspace Stay/failed Save/Discard/Save, original-only tenant update/full second-profile preservation/restore/audit+2 and three realUI logout200/401. Failed helper windows and corrected double-encoded synthetic JSON fixture remain recorded; no product endpoint relaxation. Matrix9PASS/8PARTIAL/13BLOCKED. No new migration/env/dependency/provider key/deployment or production mutation; AI20/publish0 retained, paidAI/email/realSHOPLINE0, compute stopped. Source fixes are not asserted deployed by this older cloud candidate. All original production/recovery/paid/human/merchant release gates remain.

## 真商戶 5 → 20 → 100

每階段須 hard-fail = 0、完整結果核對、無未解 cost／identity、無 stale approval、無 protected-field drift，並保留商戶 written advance/stop decision。3 接受／2 拒絕時先只修 2 件；unreported／unknown 不能當成功。supplied fresh snapshot 的獨立逐欄比較仍只證明 supplied data，相同 artifact 不能當 fresh export；operator attestation 也不等於 authenticated merchant origin。

首次真 SHOPLINE 寫入必須遵守 [production readiness 的明確確認 gate](./production-readiness.md)。完成 100 件只完成該階段，不能自行擴至全 catalog。每次 release 決定應附 exact PR/SHA/preview、DB/worker 識別、未解 gate、migration/backfill progress、audit 結果、rollback owner 與當時授權。

## 2026-10-02 provider refresh correction

The earlier Worker receipt selected a historical deployment; current status and BUILD_SHA are corrected above. [Cloud read-only refresh](./opak-cloud-readonly-refresh-2026-10-02.md) confirms production Hyperdrive origin matches the identified Neon branch but uses a BYPASSRLS owner role and enabled query caching. These are independent failed readiness gates. No cross-tenant exposure or cache-related 500 cause is asserted. Production schema still lacks existing0046, authenticated cloud smoke remains blocked, and no production change was made. The original review evidence ZIP is a dated receipt; use this supplement for current provider metadata.

## 2026-10-02 authorized staging checkpoint

The user explicitly authorized isolated synthetic cloud staging/deployment, fake AI/mock SHOPLINE, zero paid AI calls, maximum US$5 cloud cost and no production changes. [Staging rehearsal receipt](./opak-staging-rehearsal-2026-10-02.md) records a new empty Neon project, normal migrations through0053/replay/preflight, non-bypass app role, all59 tenant tables FORCE RLS, cache-disabled separate Hyperdrive, private R2 and four preview Queues. Two synthetic workspaces/three roles are seeded; own-visible1/foreign-visible0. Renderer/dry-build pass; existing local config restored.

Cloud Worker/web deployment and authenticated staging UAT remain blocked on two distinct bucket-scoped R2 credential files; no cloud acceptance is inferred. SMTP-dependent cloud flows also need a safe mock endpoint. Compute is disabled/idle during this hold; auto-suspend interval modification was denied by the provider. Production and real SHOPLINE gates are unchanged.

Latest documentation-head CI36951974507 at eaa39b4 failed on a119,420.147ms invite-field wait after Admin SPA return. The RSC/modules returned200, main was empty, and no workspace-select POST occurred. The unchanged single local case passed1/1 in12.6s;20/20 bounded navigation-only trials also passed in65.46s on a warm Windows server/reused synthetic actor. No timing comparison or source/test change was made; this does not reproduce Ubuntu CI or prove a fix/rendering mechanism. Retain the original failure and earlier full-green source/receipt evidence separately.

## 2026-10-03 isolated cloud delivery checkpoint

Current source e9d0d4ce is reviewable in PR126; current isolated candidate9dd64bf1/Preview dpl_4cZXFy8epug84HxvW9npgJEq2YDf READY and auth alias readback verified. [Executed checkpoint](./opak-staging-delivery-2026-10-03.md) supersedes prior pending synthetic approval/export/reconciliation/audit statements: actual source-import5/remote fake Queue5, reviewer4+1, A5/Brepair2/independent497cells, independent comparisons, and repaired lifecycle5/5 missing0/foreign0. Original failures remain dated evidence.

Release is still blocked: Worker pair reads own fixture and denies foreign bucket metadata, but own PUT200 proves write permission; explicit ObjectRO correction and actual denied-write test required. Complete cloud30cases/browser, exact current CI, production read/500 and merchant/paid-human/sign-off remain distinct. No merge, production change or true SHOPLINE write authorized by synthetic passes. No destructive migration/rollback or audit backfill; preserve fresh secret-bound Worker version and guarded mail-compatible Web source when holding/retesting.

## 2026-10-03 later storage/admin/outage/CI supplement

The historical storage blocker above was subsequently corrected and tested: Workerf061 ownGET200/hash, ownPUT403, foreign metadataHEAD403, then corrected version restored100%. Prior receipts are preserved; [R2 retest](./opak-staging-worker-r2-retest-2026-10-03.json) carries the actual permission evidence.

[Admin/outage/CI follow-up](./opak-staging-admin-outage-ci-2026-10-03.md) adds15/15 actual disabled-DB queue/catalog error/correlation checks and29/29 settings role/CAS/readiness checks, with original profile restored, AI20/publish0 retained, watchdog normal stop and DB disabled/idle. Cloud4PASS/11PARTIAL/15BLOCKED remains partial UAT. Head548 and unchanged-a8 retry2 fullCI passed; a8 attempt1 image TLS bind failure and unconfirmed owner remain dated evidence. The subsequent early-TLS harness/deadline cleanup change has2/2 behavioral regressions and full root142/142+14 cached app tasks, and needs its own exact-head CI.

No new migration/application env or application runtime delta. Holding retains corrected Worker credentials, primary queues, source/version/approval/audit/ledger/history and artifacts. Original production500, production repair authority/backup ownership, authenticated cloud UI, paid/human quality, employee-minute and merchant5→20→100 gates remain incomplete. No merge or production deployment based only on these synthetic/API/CI results.

## 2026-10-03 current authenticated browser/auth checkpoint

Earlier cloud-UI blockers are superseded by [actual synthetic browser acceptance](./opak-staging-browser-auth-2026-10-03.md):31/31 on preceding9dd and32/32 on reviewed733 Preview, three password roles, logout/401, both-role row support, desktop/mobile/readonly identity, admin dirty/CAS/history and catalog2448px return±2px/two-page/refresh selection/job history. Cloud matrix is7PASS/10PARTIAL/13BLOCKED; workspace-switch/invited same-context handoff and broader paid/human/merchant criteria remain partial or blocked.

The newly found pre-hydration native GET defect is repaired by explicitPOST with actual SSR RED→GREEN and scoped synthetic operator rotation/twelve session revocations. Auth source0b398a7b fullCI37111215982 SUCCESS/Vercel pass; isolated733/dpl_3uQ7X4n3rQVAkXENSFCWyfxiubCW READY/exact alias, complete tree differs only by original deployment guard. This follow-up evidence-only commit needs its own checks. No new migration/env/dependency/Worker deployment. Preserve POST and simulator-mail compatibility in any rollback; older e9 auth Web restores the native credential-URL risk.

Both actual windows stop, profile restored/AI20/publish0 retained, current staging DB disabled/idle and watchdog normal stop. Workerf061 ObjectRO proof remains valid/held. Production missing0046/BYPASSRLS/cache/recovery/effectiveDB/original500 gates remain unresolved. PR120 is an overlapping draft with failed historical Queue-browser CI; PR121–126 are review-ready, but conditional merge-to-main remains held by production readiness. Pending authority/recovery ownership, paid/human scores, employee metrics and merchant first-write/pilot gates are indexed in master-plan section15. No merge or production mutation; no synthetic proof substitutes for those gates.

## 2026-10-04 HKT verified release supplement

- [x] Source593c5283 exact fullCI37132320997 SUCCESS; source/local checks and independent catalog review remain valid. Subsequent docs-only commit must complete its own checks. PR121–126 green/CLEAN at16:22:43Z; PR120 draft/failed remains distinct.
- [x] Guardedc23 exact593 tree except branch deployment guard; READYdpl_8eC5Xw5yU1zTZ8mXPF1HWvjbvYg8/alias verified. Cloudv31 behavior39/39 proves UC05 source-qualified bilingual search and UC21 all six current-gap decisions; no batch creation or AI execution. Current matrix11PASS/6PARTIAL/13BLOCKED/all30 IDs.
- [x] Required preview audit+2/prior252 hashes preserved; other ten domain snapshots unchanged/AI20/publish0/batches2. Logout200/401; first compute-disable timeout retained, separate cleanup disabled/idle0.25CU verified and8-minute watchdog normal stop. Screenshot visually reviewed outside Git.
- [x] Worker candidatefcf96cda inactive0% from593 artifact/config,11/11 upload checks. Active correctedf061 stays100%/same deployment; secrets/queues/cron/ingress unchanged. No candidate runtime/R2/Queue pass inferred. All failed upload/browser/cleanup receipts retained.
- [ ] Production0046/owner-BYPASSRLS/cache readiness, effective Web/original500, exact production repair authority and named recovery owner/confirmed recoverable point remain incomplete. Conditional main auto-deploy merge held.
- [ ] Paid/human12-case quality, matched20-item employee benefit, fuller cloud execution/fault/load/new-invite criteria and first realSHOPLINE/5→20→100 merchant gates remain open; synthetic passes do not satisfy them.

[Executed behavior, commands, safe receipt, review scope and compatible rollback](./opak-bilingual-catalog-search-2026-10-03.md). No migration/new app env/dependency/provider key/paidAI/realSHOPLINE/production mutation. Actual cloud billing remains unmeasured. Earlier pending lines are dated evidence superseded only within these explicitly executed scopes.

Current source593 full CI is separate from the latest evidence-only commit. Exact guarded Webc23 is deployed and browser-verified; inactive Workerfcf is prepared but not activated. The previous older cloud candidate still owns earlier remote Queue/R2/audit receipts. Production normal CLI metadata is dated16:22:43Z; DB catalog is separately dated11:46–11:52Z. The original two production detail/queue500 causes are not uniquely established. [Allowlisted release receipt](./opak-bilingual-release-2026-10-04.json) and [search/regression/rollback evidence](./opak-bilingual-catalog-search-2026-10-03.md) supersede the earlier pending cloud UI/search statements without inventing model accuracy, business benefit or production acceptance.

## 2026-10-04 HKT reviewed Worker and hundred-selection checkpoint

- [x] Exact reviewed593 Workerfcf now100% in isolated staging; signed health12/12/142.695s, domain11 unchanged, non-bypass role/FORCE59/59/foreign0. Earlier inactive/f061 checkpoint is historical.
- [x] Temporary current-config R2 probe ownGET200/hash/PUT403/foreign metadata403; exactfcf restored with corrected five secret names/no probe vars. First placement-marker failure preserved; generated-config4 and probe11+cleanup10 guards pass. No secret/migration/app source change.
- [x] One normal source import100/current manual facts and locks100; actual four-page/refresh/one-field exact preview17/17. Header adapter RED1→GREEN1 and invalid filter corrected only in tooling; no duplicate import or relaxed gate.
- [x] Exactly first5 durable admissions and same-key replay; original expectation failure retained. Existing partial-copy protection correctly retains5needs-info candidates; current Worker16/16 and scoped cloud reconciliation9/9/current100 unchanged. Only original5 resumed;95remain unstarted/0queued/failed; no100 Queue pass claimed.
- [x] Real logout/queue+cron-ingress hold acknowledgements, normal independent watchdogs and fresh public404/compute disabled-idle0.25 readback; actual billing unmeasured, paidAI0/realSHOPLINE0.
- [ ] Original reviewer UC22 five-item export/filter/digest criterion on qualified100, injected cloud pause/failed-only/unknown/load/new invitation criteria; matrix remains11PASS/6PARTIAL/13BLOCKED.
- [ ] Exact production authority/recovery/role/schema/cache/effective Web/original500; paid-human quality, employee minutes and first realSHOPLINE/merchant gates. Conditional merge still held; PR120 is not green.

[Executed behavior, roots, commands, receipt and compatible hold/rollback](./opak-reviewed-worker-cloud-gates-2026-10-04.md). Source593 and prior docs d86 exact CIs passed; this new docs-only head needs its own checks. No product code fix, migration, app env, provider secret or production change inferred from evidence-helper failures.

## 2026-10-04 HKT original UC22 reviewer checkpoint

- [x] Original UC22 on100 synthetic approved current fixture: reviewer2+3 across pages, changed filter, exact5 preview; actual digest movement revokes attestation/preview without reload; server old-preview409; explicit current five re-review/confirmation yields new preview5.20/20/132.811s, AI/publish/artifacts unchanged.
- [x] Normal manual review/confirmation/bulk approval fixture100; operator403. Qualification helper status/listingStatus failure preserved; independent readback8/8/7,100cells/prior5inputs-candidates/AI30/publish0. No duplicate approval or missing byte-hash claim.
- [x] Original old batch95 unstarted cancelled through service; only5 re-reviewed on fresh source. Other95 approvals historical after refresh; no100 Queue/merchant success claim. Sessions/queues/ingress/compute held; currentfcf100/source593/HEAD404/idle0.25 independently read back.
- [x] Cloud matrix updated only UC22:12PASS/5PARTIAL/13BLOCKED/all30.
- [ ] Latest docs head ownCI; c3 attempt1 website dispatch failure retained, unchanged-head reproduction pending; no unique underlying ingress cause or source fix claimed.
- [ ] UC03/06/23/24/29 partial; paid-human UC09–20 and load/employee UC30 blocked. Production authority/recovery/role/schema/cache/effective Web/original500 and separate merchant first-write gates remain open. Conditional merge held.

[Commands, exact criteria, failure disposition, safe receipt and hold/rollback](./opak-uc22-reviewer-cloud-2026-10-04.md). Prior checkpoints remain dated; this supersedes only the old UC22 pending criterion, not other release gates.

## 2026-10-04 HKT UC23 remote failure checkpoint

- [x] Real isolated Queue3success/1knownfailure/1pending; normalUI pause202, paused advance0 and retry409 with unchanged runs. Same-batch refresh resolves expected stale-control409; Resume202 and failed-only one attempt2/idempotent replay; final5success/6total including old failure.30/30 completion; original3success ledger/run values, older workspace records, manual locks and source cells retained;11fake ledger records cost0/publish0.
- [x] All11 windows normal watchdog stops/cleanup acknowledgements; reviewedfcf restored100%/no probe vars/public404/compute disabled-idle0.25. No paidAI/realSHOPLINE/production change; billing unmeasured; remote paused/cron flags independently unavailable.
- [x] ST27/T06 reproduced paused label omitted from shared state mapper; bilingual rendered regression RED2→GREEN17/17, fulltest14tasks/Web2285.
- [x] Cloud matrix changes only UC23 to passed:13PASS/4PARTIAL/13BLOCKED/all30. Earlier failed dispatch/proxy-shape/invalid-output/support/stale-CAS receipts remain dated evidence.
- [ ] New label candidate lint14/typecheck14/build8 and automated static checks passed; exact CI/protected preview and final release pack pending at this precommit checkpoint.
- [ ] UC03/06/24/29 partial; paid-human UC09–20/load-employee UC30 blocked. Production exact authority/recovery/schema/role/cache/effective Web/original500 and merchant first-write/pilot gates remain open. Conditional main merge held.

[Behavior, root classifications, commands, safe receipts and rollback](./opak-uc23-cloud-pause-retry-2026-10-04.md). Historical checkpoints remain unchanged.

## 2026-10-04 HKT UC23 verified candidate supplement

- [x] ST27 paused label fixed; full test14tasks/Web2285, lint14/typecheck14/build8. Exact validation5b900e6a CI37156825749 SUCCESS/43 steps; prior5f9 format failure retained and corrected without assertion/gate relaxation.
- [x] Protected Web2b8d77be/dpl_J3hvtmygPraTyp2XakUM9k2TXXH6 actual bilingual14/14/92.247s; one zero-admission normal batch reused after helper locator failure, then cancelled; eight domain hashes unchanged. Screenshots reviewed. Workerfcf/source593 unchanged and separately versioned; sourceWeb5f9 contains only label runtime delta.
- [x] All13 resource windows normal stops; fresh2026-10-03T22:05:04.532Z candidatefcf100/no probes/public404/compute disabled-idle0.25. Queue pause/cron flags remain acknowledgement-only and billing unmeasured. No paidAI/realSHOPLINE/production mutation.
- [x] Current UAT13PASS/4PARTIAL/13BLOCKED/all30; only UC23 advanced. Source/current-input/manual-lock/frozen retry/idempotency/cost/approval/RLS safeguards retained.
- [ ] This new docs-only head needs its own exact CI; final PR metadata/readback and immutable archive remain to be recorded outside Git.
- [ ] Production exact first-operation authority/named recovery owner/confirmed recoverable point/schema/role/cache/effective Web/original500 remain open; paid-human quality, full20-item journey/employee benefit/cloudload, first trueSHOPLINE/merchant5→20→100 gates remain distinct. Conditional main auto-deploy merge held; PR120 remains an overlapping non-green draft.

[Executed UC23 and compatible hold/rollback](./opak-uc23-cloud-pause-retry-2026-10-04.md). Earlier pending lines are dated; this supplement supersedes only the verified label candidate/cloud scope.

## 2026-10-04 HKT original UC06 verified intake checkpoint

- [x] Exact original CSV criterion reread:20 synthetic products/import/store check/match/draft/unchanged ProductID-SKU-source binding. No added merchant-write or full-generation requirement; human/employee/merchant gates remain separate.
- [x] Single normalUI readonly20 → connected maintenance20/current editable inputs20; explicit store/identity/source confirmations; exact20 unique ID/SKU/store/source mappings and1,420 logical source-column comparisons. Same-byte UI replay same receipt/0new drafts/eleven-domain equality.
- [x] Same20 realUI detail pages editable/noAI/current revision1/no active version; source/price/stock retained/audit20. Read-only continuation38/38/173.011s/eleven-domain equality/AI56/publish0/batch count unchanged; four synthetic screenshots visually reviewed.
- [x] All four8-minute windows stop normally; logout/Queue/ingress/compute acknowledged. Fresh2026-10-04T01:02:14.530Z metadata confirms reviewedfcf100/source593/no probes/public404/disabled-idle0.25CU. No migration/env/paidAI/merchant/production mutation; billing unmeasured.
- [x] Three helper failures retained: missing Workbook tab, early tab state and malformed platform filter400. v3 command stays failed after20 successful import/replay checks; v4 continues same20 with0 repeat imports. Lost pre-import full snapshot is not invented; replay and read-only equality scopes remain explicit.
- [x] Current cloud matrix14PASS/3PARTIAL/13BLOCKED/all30; only UC06 advanced. Prior e52 ownCI37158090454 attempt2 SUCCESS43 verified, first admin-SPA timeout root unconfirmed and retained. PR121–126 green/CLEAN;120nongreen draft.
- [ ] New docs-only exact-head CI/publication/immutable archive are completed in outside-Git terminal receipts, keeping self-referential evidence commits out of the code branch.
- [ ] Original production500/effective Web/0046/safe role/cache/exact authority/named recovery owner/confirmed point; simulated cloud positive-budget/unknown gates; paid-human quality/cloudload/matched employee20minutes; first realSHOPLINE/reconciled5→20→100 remain open. Conditional main auto-deploy merge held.

[Executed behavior, failures, exact criteria and compatible hold](./opak-uc06-cloud-intake-2026-10-04.md). Historical unchecked checkpoints are superseded only by the explicit executed scope above. Existing application already implements this behavior; no product rewrite or new production authority is inferred.
