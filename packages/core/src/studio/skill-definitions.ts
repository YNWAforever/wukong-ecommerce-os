import {
  skillDefinitionSchema,
  STUDIO_ROLE_RANK,
  type BilingualText,
  type SkillDefinition,
  type SkillInputDescription,
  type StudioRole,
} from "./skill-schemas.js";
import { getTool, type ToolDefinition } from "./tool-definitions.js";

/**
 * The reviewed, versioned Studio skill registry (spec §1.2, §3.6).
 *
 * Availability is a property of the definition: `pilot` may execute, while
 * `planned` and `blocked` skills still render on template cards with their
 * own limitation line but never run. Activating a version is a reviewed code
 * change, not a runtime mutation.
 *
 * Every allowlisted tool must also exist in the tool registry; the module
 * validates both registries when it initialises, so an inconsistent edit
 * fails at import instead of at the first paid turn.
 */

const SKILL_ENTRIES: readonly SkillDefinition[] = [
  {
    key: "catalog.find",
    version: "1.0.0",
    status: "pilot",
    title: {
      "zh-Hant": "尋找與解釋商品",
      en: "Find and explain listings",
    },
    outcome: {
      "zh-Hant": "從工作區記錄找出商品，並解釋其品質、狀態與相關作業。",
      en: "Find listings in workspace records and explain their quality, state and related jobs.",
    },
    limitation: {
      "zh-Hant": "只根據工作區現有記錄回答；記錄沒有的事項會標示為未知。",
      en: "Answers only from existing workspace records; anything not recorded is reported as unknown.",
    },
    inputs: [
      {
        name: "query",
        description: {
          "zh-Hant": "要尋找的商品、SKU 或關鍵字。",
          en: "Listing, SKU or keyword to find.",
        },
      },
    ],
    optionalInputs: [
      {
        name: "limit",
        description: {
          "zh-Hant": "最多回傳的商品數量（1 至 50）。",
          en: "Maximum listings to return (1 to 50).",
        },
      },
    ],
    allowedTools: [
      "catalog.search",
      "catalog.get",
      "quality.get_gaps",
      "jobs.list",
    ],
    outputKind: "answer",
    evidence: {
      requiredSources: ["catalog", "listing", "quality", "job"],
      unknownsPolicy: "null-with-reason",
    },
    budgetClass: "free",
    completion: "schema+evidence",
  },
  {
    key: "catalog.gap_review",
    version: "1.0.0",
    status: "pilot",
    title: {
      "zh-Hant": "檢視阻擋核准與匯出的缺口",
      en: "Review approval and export gaps",
    },
    outcome: {
      "zh-Hant": "列出哪些商品因品質缺口而無法核准或匯出，以及原因。",
      en: "List which listings are blocked from approval or export, and why.",
    },
    limitation: {
      "zh-Hant": "只反映工作區記錄中的缺口；未被評估的項目標示為未知，不是零。",
      en: "Reflects recorded gaps only; unevaluated items are unknown, not zero.",
    },
    inputs: [],
    optionalInputs: [
      {
        name: "listingIds",
        description: {
          "zh-Hant": "要檢視的商品識別碼；省略時檢視整個工作區。",
          en: "Listing ids to review; omit to review the whole workspace.",
        },
      },
    ],
    allowedTools: [
      "catalog.search",
      "catalog.get",
      "quality.get_gaps",
      "exports.get",
    ],
    outputKind: "gap_report",
    evidence: {
      requiredSources: ["catalog", "listing", "quality", "export_attempt"],
      unknownsPolicy: "null-with-reason",
    },
    budgetClass: "free",
    completion: "schema+evidence",
  },
  {
    key: "listing.copy_proposal",
    version: "1.1.0",
    status: "pilot",
    title: {
      "zh-Hant": "產生文案建議",
      en: "Propose listing copy",
    },
    outcome: {
      "zh-Hant": "為一個商品版本產生有證據依據的文案建議，供操作員審核。",
      en: "Produce evidence-backed copy suggestions for one listing version for operator review.",
    },
    limitation: {
      "zh-Hant": "只產生建議，不會寫入或覆蓋商品資料；須在現有審核畫面處理。",
      en: "Proposals only; it never writes canonical listing data and must be reviewed in the existing screen.",
    },
    inputs: [
      {
        name: "listingId",
        description: {
          "zh-Hant": "要產生文案建議的商品。",
          en: "Listing to propose copy for.",
        },
      },
    ],
    optionalInputs: [
      {
        name: "fields",
        description: {
          "zh-Hant": "要處理的欄位；省略時由伺服器決定安全範圍。",
          en: "Fields to cover; the server picks the safe set when omitted.",
        },
      },
    ],
    allowedTools: ["catalog.get", "quality.get_gaps", "listing.propose_copy"],
    outputKind: "copy_proposal",
    evidence: {
      requiredSources: ["listing", "quality"],
      unknownsPolicy: "null-with-reason",
    },
    budgetClass: "model-turns-v1",
    completion: "schema+evidence+readback",
  },
  {
    key: "listing.draft_from_sources",
    version: "1.1.0",
    status: "pilot",
    title: {
      "zh-Hant": "從來源建立商品草稿",
      en: "Create listing draft from sources",
    },
    outcome: {
      "zh-Hant": "從已附上的來源素材建立草稿，並交由現有上架流程處理。",
      en: "Create a draft from attached source material and hand it to the existing listing pipeline.",
    },
    limitation: {
      "zh-Hant":
        "推行前必須由操作員明確確認；Studio 不會自行核准、發佈或寫入 SHOPLINE。",
      en: "Requires explicit operator confirmation; Studio never approves, publishes or writes to SHOPLINE.",
    },
    inputs: [
      {
        name: "assetIds",
        description: {
          "zh-Hant": "作為來源的已上傳素材識別碼。",
          en: "Uploaded source asset ids to build the draft from.",
        },
      },
    ],
    optionalInputs: [
      {
        name: "note",
        description: {
          "zh-Hant": "一併交給上架流程的操作員備註。",
          en: "Operator note passed to the listing pipeline.",
        },
      },
    ],
    allowedTools: [
      "catalog.search",
      "assets.list",
      "listing.create_draft",
      "listing.get_run_status",
    ],
    outputKind: "dispatch",
    evidence: {
      requiredSources: ["source_import", "listing", "job"],
      unknownsPolicy: "null-with-reason",
    },
    budgetClass: "free",
    completion: "schema+evidence+readback",
  },
  {
    key: "merchant.audit",
    version: "1.0.0",
    status: "planned",
    title: {
      "zh-Hant": "商戶與 SEO 稽核報告",
      en: "Merchant and SEO audit report",
    },
    outcome: {
      "zh-Hant": "依工作區記錄整理可匯出的稽核報告，附證據表與資料時間。",
      en: "Compose an exportable audit report from workspace records with an evidence table and as-of time.",
    },
    limitation: {
      "zh-Hant": "報告只反映讀取時的記錄；缺少的資料標示為缺失，不會以零代替。",
      en: "Reflects records at read time only; missing data is marked missing, never zero.",
    },
    inputs: [],
    optionalInputs: [
      {
        name: "from",
        description: {
          "zh-Hant": "稽核期間的開始日期（含）。",
          en: "Inclusive start date of the audit period.",
        },
      },
      {
        name: "to",
        description: {
          "zh-Hant": "稽核期間的結束日期（含）。",
          en: "Inclusive end date of the audit period.",
        },
      },
    ],
    allowedTools: [
      "catalog.search",
      "catalog.get",
      "quality.get_gaps",
      "exports.get",
    ],
    outputKind: "merchant_audit",
    evidence: {
      requiredSources: [
        "catalog",
        "quality",
        "export_attempt",
        "shopline_projection",
      ],
      unknownsPolicy: "null-with-reason",
    },
    budgetClass: "free",
    completion: "schema+evidence+readback",
  },
  {
    key: "product_shot.prepare",
    version: "1.0.0",
    status: "planned",
    title: {
      "zh-Hant": "準備產品圖片",
      en: "Prepare product shots",
    },
    outcome: {
      "zh-Hant": "從商品來源素材準備產品圖片處理，並在既有圖片流程中審核。",
      en: "Prepare product-shot processing from listing source assets and review it in the existing flow.",
    },
    limitation: {
      "zh-Hant":
        "圖片處理沿用既有受控流程；Studio 不直接呼叫外部服務，也不保存簽署網址。",
      en: "Reuses the existing gated flow; Studio never calls the external service directly or stores signed URLs.",
    },
    inputs: [
      {
        name: "listingId",
        description: {
          "zh-Hant": "要準備產品圖片的商品。",
          en: "Listing to prepare product shots for.",
        },
      },
    ],
    optionalInputs: [],
    allowedTools: ["assets.list"],
    outputKind: "dispatch",
    evidence: {
      requiredSources: ["listing"],
      unknownsPolicy: "null-with-reason",
    },
    budgetClass: "free",
    completion: "schema+evidence",
  },
  {
    key: "category.map_proposal",
    version: "1.0.0",
    status: "planned",
    title: {
      "zh-Hant": "建議分類對應",
      en: "Propose category mapping",
    },
    outcome: {
      "zh-Hant": "建議商品在平台分類中的對應，並附上信心與依據供審核。",
      en: "Suggest platform category mappings with confidence and supporting evidence for review.",
    },
    limitation: {
      "zh-Hant": "只提出建議；套用仍須在既有目錄流程中由人員完成。",
      en: "Suggestions only; applying them remains a human action in the existing catalog flow.",
    },
    inputs: [
      {
        name: "listingId",
        description: {
          "zh-Hant": "要建議分類的商品。",
          en: "Listing to propose a category for.",
        },
      },
    ],
    optionalInputs: [],
    allowedTools: ["catalog.search", "catalog.get"],
    outputKind: "finding",
    evidence: {
      requiredSources: ["catalog", "listing"],
      unknownsPolicy: "null-with-reason",
    },
    budgetClass: "model-turns-v1",
    completion: "schema+evidence+readback",
  },
  {
    key: "supplier.intel_proposal",
    version: "1.0.0",
    status: "planned",
    title: {
      "zh-Hant": "整理供應商情報",
      en: "Compile supplier intelligence",
    },
    outcome: {
      "zh-Hant":
        "從工作簿匯入與網站商品記錄整理欄位級供應商建議，供審核後儲存。",
      en: "Compile field-level supplier suggestions from workbook imports and website product records for reviewed saving.",
    },
    limitation: {
      "zh-Hant": "只根據已匯入或已掃描的來源；未有來源的欄位維持未知。",
      en: "Only from imported or scanned sources; fields without a source stay unknown.",
    },
    inputs: [
      {
        name: "listingId",
        description: {
          "zh-Hant": "要整理供應商情報的商品。",
          en: "Listing to compile supplier intelligence for.",
        },
      },
    ],
    optionalInputs: [],
    allowedTools: ["imports.list", "catalog.get"],
    outputKind: "finding",
    evidence: {
      requiredSources: ["workbook", "source_import", "website"],
      unknownsPolicy: "null-with-reason",
    },
    budgetClass: "model-turns-v1",
    completion: "schema+evidence+readback",
  },
  {
    key: "customer.reply_draft",
    version: "1.0.0",
    status: "blocked",
    title: {
      "zh-Hant": "草擬客服回覆",
      en: "Draft customer replies",
    },
    outcome: {
      "zh-Hant": "草擬客服回覆並附上依據。",
      en: "Draft customer replies with supporting evidence.",
    },
    limitation: {
      "zh-Hant": "封鎖：Wukong 沒有客服收件匣或訊息來源，不會偽造收件匣資料。",
      en: "Blocked: Wukong has no customer inbox or message source; no inbox data is fabricated.",
    },
    inputs: [],
    optionalInputs: [],
    allowedTools: [],
    outputKind: "none",
    evidence: {
      requiredSources: [],
      unknownsPolicy: "null-with-reason",
    },
    budgetClass: "free",
    completion: "schema",
  },
  {
    key: "logistics.followup",
    version: "1.0.0",
    status: "blocked",
    title: {
      "zh-Hant": "物流跟進",
      en: "Follow up logistics",
    },
    outcome: {
      "zh-Hant": "跟進訂單與出貨狀態。",
      en: "Follow up order and shipment status.",
    },
    limitation: {
      "zh-Hant": "封鎖：Wukong 沒有訂單或出貨資料來源；不會以推測代替記錄。",
      en: "Blocked: Wukong has no order or shipment data source; guesswork never replaces records.",
    },
    inputs: [],
    optionalInputs: [],
    allowedTools: [],
    outputKind: "none",
    evidence: {
      requiredSources: [],
      unknownsPolicy: "null-with-reason",
    },
    budgetClass: "free",
    completion: "schema",
  },
];

/**
 * A role can execute a turn only if it can already act in the workspace
 * (operator+; spec §4 gives viewers read-only access). The skill must be
 * `pilot`, and every tool the skill may use must be within the role's
 * capability — the registry never grants a capability the role lacks.
 */
const MIN_EXECUTION_ROLE: StudioRole = "operator";

function freezeBilingual(text: BilingualText): BilingualText {
  return Object.freeze({ ...text });
}

function freezeInputDescription(
  input: SkillInputDescription,
): SkillInputDescription {
  return Object.freeze({
    name: input.name,
    description: freezeBilingual(input.description),
  });
}

function freezeSkillDefinition(skill: SkillDefinition): SkillDefinition {
  return Object.freeze({
    ...skill,
    title: freezeBilingual(skill.title),
    outcome: freezeBilingual(skill.outcome),
    limitation: freezeBilingual(skill.limitation),
    inputs: Object.freeze(skill.inputs.map(freezeInputDescription)),
    optionalInputs: Object.freeze(
      skill.optionalInputs.map(freezeInputDescription),
    ),
    allowedTools: Object.freeze([...skill.allowedTools]),
    evidence: Object.freeze({
      requiredSources: Object.freeze([...skill.evidence.requiredSources]),
      unknownsPolicy: skill.evidence.unknownsPolicy,
    }),
    ...(skill.upstream
      ? { upstream: Object.freeze({ ...skill.upstream }) }
      : {}),
  });
}

function validateSkillRegistry(skills: readonly SkillDefinition[]): void {
  const keys = new Set<string>();
  for (const skill of skills) {
    skillDefinitionSchema.parse(skill);
    if (keys.has(skill.key)) {
      throw new Error(`duplicate studio skill key: ${skill.key}`);
    }
    keys.add(skill.key);
    for (const toolId of skill.allowedTools) {
      if (!getTool(toolId)) {
        throw new Error(
          `studio skill ${skill.key} allowlists unknown tool: ${toolId}`,
        );
      }
    }
  }
}

validateSkillRegistry(SKILL_ENTRIES);

export const SKILL_DEFINITIONS: readonly SkillDefinition[] = Object.freeze(
  SKILL_ENTRIES.map(freezeSkillDefinition),
);

export function getSkill(key: string): SkillDefinition | undefined {
  return SKILL_DEFINITIONS.find((skill) => skill.key === key);
}

function isSkillExecutable(skill: SkillDefinition): boolean {
  return skill.status === "pilot";
}

/**
 * Rejects a tool request that is unknown or outside the skill's reviewed
 * allowlist. Callers pass the raw requested id (model/tool input), so the
 * lookup itself is the validation step; this is not a retryable failure.
 */
export function assertToolAllowed(
  skill: SkillDefinition,
  toolId: string,
): ToolDefinition {
  const tool = getTool(toolId);
  if (!tool) {
    throw new Error(`unknown studio tool: ${toolId}`);
  }
  if (!skill.allowedTools.includes(tool.id)) {
    throw new Error(
      `studio tool not allowed for skill ${skill.key}: ${toolId}`,
    );
  }
  return tool;
}

/**
 * Executable skills for a role. `planned` and `blocked` definitions are
 * excluded even when a request names them, and a viewer gets none.
 */
export function skillsForRole(role: StudioRole): readonly SkillDefinition[] {
  const rank = STUDIO_ROLE_RANK[role];
  if (rank < STUDIO_ROLE_RANK[MIN_EXECUTION_ROLE]) {
    return Object.freeze([]);
  }
  return Object.freeze(
    SKILL_DEFINITIONS.filter((skill) => {
      if (!isSkillExecutable(skill)) return false;
      return skill.allowedTools.every((toolId) => {
        const tool = getTool(toolId);
        return tool !== undefined && rank >= STUDIO_ROLE_RANK[tool.minRole];
      });
    }),
  );
}
