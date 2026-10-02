# Opak 維護修復 release／rollback pack

日期：2026-10-01。此文件記錄可審閱的候選版本與放行條件；首次 SHOPLINE 真寫入仍須另有明確確認。原商戶附件、workbooks、screenshots、模型輸出及 connection strings 留在 repo 外的私人證據位置。

## 三個互相獨立的結果

| 結果                     | 現況                                                                                                                 | 放行所需證據                                                                                                                     |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| code-ready               | A–F historical tested heads完整 CI SUCCESS／READY；最新docs-only eaa39b4 CI browser16/17，Admin SPA blank-render未解 | 終態候選SHA／CI／preview及其後docs-only checks見fix-status與PR；歷史通過不代替最新check                                          |
| production-read-verified | blocked                                                                                                              | 正式 web 實際使用的 DB/schema 識別、部署一致性、已授權 operator/reviewer 對原詳情／queue 的非破壞 smoke、安全 request/stage 證據 |
| merchant-pilot-accepted  | blocked                                                                                                              | 首次真寫入的獨立確認、5 → 20 → 100 各階段結果核對、最新已授權 merchant export 的獨立逐欄核對、商戶簽署                           |

READY preview 不等於已登入驗收；fake AI 成功不等於模型準確；下載成功不等於 SHOPLINE 已接受。不得將部分結果合併成「全通過」。每個 UC 的歷史結果與本輪結果見 [30-case 結果表](./opak-uat-results-2026-10-01.md)。

## 版本與部署識別

| 部件                     | 核對到的識別                                                                                                                                                          | 限制                                                                                                                                                              |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 審核 baseline／當時 main | `dde9e178d9e1f9ca8880618c63104f41fe2fa3be`                                                                                                                            | 用作比較，不要求退回                                                                                                                                              |
| production web           | Vercel `dpl_4UtLTAFZmKDsyPgPKtvHMBBBbDxm`；上述 main SHA                                                                                                              | 未完成 authenticated 原問題 smoke；release 前需重查 alias 與 SHA                                                                                                  |
| production worker        | Current deployment `01bb6ad8-6227-49b9-b903-43ccb22488ee`; version `6842b51c-95ce-4bdf-989d-36a645be8f59`, 100%; BUILD_SHA `3ca5b99520e056bda99c0efbe87192e619026f04` | 2026-10-02 status refresh; configured Hyperdrive uses BYPASSRLS origin and enabled query cache. See [cloud refresh](./opak-cloud-readonly-refresh-2026-10-02.md). |
| production DB            | Neon project `weathered-lake-51694428`；main/default branch `br-twilight-meadow-at9qky4q`；`neondb`，PG 17.11                                                         | read-only metadata 顯示缺少既有 0046 source-binding 欄／FK；effective web connection 尚未確認                                                                     |
| A                        | [PR #121](https://github.com/YNWAforever/wukong-ecommerce-os/pull/121)；`1707ab17c8527973ec4047b55a008ffd1863998a`                                                    | draft，未合併                                                                                                                                                     |
| B                        | [PR #122](https://github.com/YNWAforever/wukong-ecommerce-os/pull/122)；`a181cda3d163b2f8825bef1582839a99aca96429`                                                    | draft，stacked on A                                                                                                                                               |
| C                        | [PR #123](https://github.com/YNWAforever/wukong-ecommerce-os/pull/123)；`ee26897fdd2728b685ec224c82e50ce4699353db`                                                    | draft，stacked on B                                                                                                                                               |
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

## 真商戶 5 → 20 → 100

每階段須 hard-fail = 0、完整結果核對、無未解 cost／identity、無 stale approval、無 protected-field drift，並保留商戶 written advance/stop decision。3 接受／2 拒絕時先只修 2 件；unreported／unknown 不能當成功。supplied fresh snapshot 的獨立逐欄比較仍只證明 supplied data，相同 artifact 不能當 fresh export；operator attestation 也不等於 authenticated merchant origin。

首次真 SHOPLINE 寫入必須遵守 [production readiness 的明確確認 gate](./production-readiness.md)。完成 100 件只完成該階段，不能自行擴至全 catalog。每次 release 決定應附 exact PR/SHA/preview、DB/worker 識別、未解 gate、migration/backfill progress、audit 結果、rollback owner 與當時授權。

## 2026-10-02 provider refresh correction

The earlier Worker receipt selected a historical deployment; current status and BUILD_SHA are corrected above. [Cloud read-only refresh](./opak-cloud-readonly-refresh-2026-10-02.md) confirms production Hyperdrive origin matches the identified Neon branch but uses a BYPASSRLS owner role and enabled query caching. These are independent failed readiness gates. No cross-tenant exposure or cache-related 500 cause is asserted. Production schema still lacks existing0046, authenticated cloud smoke remains blocked, and no production change was made. The original review evidence ZIP is a dated receipt; use this supplement for current provider metadata.

## 2026-10-02 authorized staging checkpoint

The user explicitly authorized isolated synthetic cloud staging/deployment, fake AI/mock SHOPLINE, zero paid AI calls, maximum US$5 cloud cost and no production changes. [Staging rehearsal receipt](./opak-staging-rehearsal-2026-10-02.md) records a new empty Neon project, normal migrations through0053/replay/preflight, non-bypass app role, all59 tenant tables FORCE RLS, cache-disabled separate Hyperdrive, private R2 and four preview Queues. Two synthetic workspaces/three roles are seeded; own-visible1/foreign-visible0. Renderer/dry-build pass; existing local config restored.

Cloud Worker/web deployment and authenticated staging UAT remain blocked on two distinct bucket-scoped R2 credential files; no cloud acceptance is inferred. SMTP-dependent cloud flows also need a safe mock endpoint. Compute is disabled/idle during this hold; auto-suspend interval modification was denied by the provider. Production and real SHOPLINE gates are unchanged.

Latest documentation-head CI36951974507 at eaa39b4 failed on a119,420.147ms invite-field wait after Admin SPA return. The RSC/modules returned200, main was empty, and no workspace-select POST occurred. The unchanged single local case passed1/1 in12.6s;20/20 bounded navigation-only trials also passed in65.46s on a warm Windows server/reused synthetic actor. No timing comparison or source/test change was made; this does not reproduce Ubuntu CI or prove a fix/rendering mechanism. Retain the original failure and earlier full-green source/receipt evidence separately.
