/**
 * The single source of truth for capability maturity, consumed by both the
 * /admin "System Truth" tab and /system-map -- see the design doc at
 * docs/superpowers/specs/2026-09-01-capability-registry-system-map-admin-tab-design.md
 * for why this is a static, hand-maintained list rather than a live
 * environment-variable check: the most safety-critical entry here
 * (shopline-real-publish) is gated by SHOPLINE_PUBLISH_ENABLED, which is
 * only ever read in apps/worker, never apps/web -- there is no live signal
 * this module could read without introducing a second, driftable copy of
 * that flag into the Vercel deployment. Update an entry's `state` in the
 * SAME pull request that changes the underlying capability's real state.
 */

export type CapabilityState = "implemented" | "pilot" | "planned" | "blocked";

export type CapabilityEntry = {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly labelZh: string;
  readonly descriptionZh: string;
  readonly state: CapabilityState;
};

const CAPABILITY_ENTRIES: readonly CapabilityEntry[] = [
  {
    id: "shopline-real-publish",
    label: "Real SHOPLINE publishing",
    labelZh: "SHOPLINE 正式發佈",
    description:
      "Real writes require separate authorization and operational verification. This registry does not inspect deployment configuration.",
    descriptionZh: "正式寫入需要獨立授權及操作驗證；本登記冊不讀取部署設定。",
    state: "blocked",
  },
  {
    id: "ai-listing-generation",
    label: "AI-assisted listing generation",
    labelZh: "AI 商品資訊生成",
    description:
      "AI listing generation and provider integration are implemented. Operational status requires separate verification.",
    descriptionZh:
      "已實作 AI 商品內容生成介面及供應商整合；操作狀態須另行驗證。",
    state: "implemented",
  },
  {
    id: "bulk-form-import-freshness-gate",
    label: "Bulk-form import + freshness gate",
    labelZh: "批次匯入與時效檢查",
    description:
      "Merchant-attested import time and source/version/digest checks are implemented. Merchant-side freshness is not independently verified.",
    descriptionZh:
      "已實作商戶確認的匯入時間及來源、版本、摘要檢查；不核實商戶端時效。",
    state: "implemented",
  },
  {
    id: "attended-enrichment-batches",
    label: "Attended AI-enrichment batches",
    labelZh: "AI 批次強化",
    description:
      "Batch creation, wave advancement and review views are implemented for pilot evaluation.",
    descriptionZh: "已實作批次建立、波次推進及審核介面，供試行評估。",
    state: "pilot",
  },
  {
    id: "multi-product-export",
    label: "Multi-product export",
    labelZh: "多商品匯出",
    description:
      "Export approved, source-checked listings as a workbook. Generation does not verify SHOPLINE acceptance.",
    descriptionZh:
      "將已批准且來源檢查通過的商品匯出為工作簿；匯出不等於 SHOPLINE 接受。",
    state: "pilot",
  },
  {
    id: "jobs-ledger",
    label: "Jobs ledger",
    labelZh: "作業總覽",
    description:
      "Read the complete workspace job history with pagination. Metrics have a separately stated time window.",
    descriptionZh: "以分頁檢視工作區完整作業歷史；指標另有明確時間範圍。",
    state: "pilot",
  },
  // Conversation Studio entries. Added with the P1 foundation shell, before
  // any deterministic answer, model turn or MCP transport exists, so every
  // state below describes the source tree as it actually is today. The design
  // spec's later phases each move one entry to "pilot"/"implemented" in the
  // same change that delivers it.
  {
    id: "conversation-studio",
    label: "Conversation Studio",
    labelZh: "對話工作室",
    description:
      "Pilot, verified locally: flagged Studio shell, deterministic records answers with evidence and execution traces, durable threads, copy proposals, confirmed listing-draft dispatch and merchant audit reports. Live model analysis is separate and off by default; a conversation never writes canonical data, approves or publishes.",
    descriptionZh:
      "試行並已於本機驗證：受功能旗標控制的工作室外殼、附證據及執行步驟的記錄回答、持久對話、文案建議、經確認的上架草稿派送及商戶審核報告。即時模型分析另行控制且預設關閉；對話不會寫入正式資料、批准或發佈。",
    state: "pilot",
  },
  {
    id: "conversation-studio-ai",
    label: "Studio live analysis",
    labelZh: "工作室即時分析",
    description:
      "Not activated. The typed proposer/analysis ports, untrusted-input prompts, claim grounding and reviewed budget admission exist and are tested with fakes, but no live provider run has been recorded. Live analysis requires a reviewed workspace model and budget plus the AI flag, and it never gains write authority.",
    descriptionZh:
      "尚未啟用。已具備並以測試替身驗證：具型別的建議／分析介面、不受信任輸入提示、主張依據檢查及已審核預算准入；但未記錄任何正式供應商執行。即時分析需要另行設定的工作區模型及預算，並受 AI 旗標控制，且不會取得寫入權限。",
    state: "planned",
  },
  {
    id: "wukong-mcp-server",
    label: "Wukong-hosted MCP server",
    labelZh: "Wukong 託管 MCP 伺服器",
    description:
      "Verified locally: a stateless JSON-RPC MCP endpoint serves reviewed read/propose tools to a scoped workspace token, gated by the feature flags and the creator's current role. Dispatch and every write path are never exposed, and external MCP connections stay blocked.",
    descriptionZh:
      "已於本機驗證：無狀態 JSON-RPC MCP 端點以工作區範圍權杖提供已審核的讀取／建議工具，受功能旗標及建立者現行角色限制。不提供派送或任何寫入路徑，外部 MCP 連線仍維持封鎖。",
    state: "pilot",
  },
  {
    id: "external-mcp-connections",
    label: "External MCP connections",
    labelZh: "外部 MCP 連線",
    description:
      "Disabled by default. No user-supplied endpoint or credential is accepted, and every connection stays blocked until an allowlist and credential-ownership decision exists.",
    descriptionZh:
      "預設停用。不接受使用者提供的端點或憑證；在完成允許清單及憑證擁有權決定前，所有連線維持封鎖。",
    state: "blocked",
  },
  {
    id: "studio-output-signoff",
    label: "Studio output sign-off",
    labelZh: "工作室輸出簽核",
    description:
      "Pilot, verified locally: versioned copy-proposal and merchant-audit artifacts can be saved by an operator and signed off by a reviewer, with audit and canonical JSON export that re-checks the preview digest. Sign-off is an artifact state only, never a listing approval or a publish action.",
    descriptionZh:
      "試行並已於本機驗證：具版本的文案建議及商戶審核成果可由操作員儲存、由審核員簽核，並附稽核及會重新核對預覽摘要的標準 JSON 匯出。簽核僅屬成果狀態，並非商品批准或發佈。",
    state: "pilot",
  },
];

// A runtime backstop alongside the type-level `readonly` above --
// `readonly CapabilityEntry[]` and per-field `readonly` are compile-time
// only, so without this a consumer could still write
// `CAPABILITY_REGISTRY[0].state = "implemented"` (or `.push(...)`) and silently
// mutate the shared singleton every future consumer imports. Object.freeze
// is shallow, so each entry is frozen individually before the array itself
// is frozen -- freezing only the array would leave the nested entry
// objects mutable.
export const CAPABILITY_REGISTRY: readonly CapabilityEntry[] = Object.freeze(
  CAPABILITY_ENTRIES.map((entry) => Object.freeze({ ...entry })),
);
