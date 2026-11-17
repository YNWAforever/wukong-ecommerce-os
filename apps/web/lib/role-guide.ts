import type { Locale } from "./locale";
import type { WorkspaceRole } from "./session-context";

/**
 * One line of what a workspace role can do. Shared by the account menu and the
 * Studio team page so both describe the same server-enforced role boundary.
 */
export const ROLE_GUIDE: Record<
  WorkspaceRole,
  { readonly zh: string; readonly en: string }
> = {
  viewer: {
    zh: "你只能閱讀；建立對話或審核請聯絡管理員或操作員。",
    en: "Read-only: ask an admin or operator to start a conversation or review.",
  },
  operator: {
    zh: "你可以執行引導審核並準備內容；簽核與設定需要審核員或管理員。",
    en: "You can run guided reviews and prepare work; sign-off and settings need a reviewer or admin.",
  },
  reviewer: {
    zh: "你可以審核並簽核已準備的內容；設定與連線需要管理員。",
    en: "You can review and sign off prepared work; settings and connections need an admin.",
  },
  admin: {
    zh: "你可以審核、簽核並管理工作區設定與連線。",
    en: "You can review, sign off and manage workspace settings and connections.",
  },
  owner: {
    zh: "完整工作區控制，包括設定、連線與角色。",
    en: "Full workspace control, including settings, connections and roles.",
  },
};

export const TEAM_ROLE_ORDER: readonly WorkspaceRole[] = [
  "viewer",
  "operator",
  "reviewer",
  "admin",
  "owner",
];

export function roleGuideText(role: WorkspaceRole, locale: Locale): string {
  return locale === "en" ? ROLE_GUIDE[role].en : ROLE_GUIDE[role].zh;
}
