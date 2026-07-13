import { eq } from "drizzle-orm";
import type { WorkspaceProfile } from "@wukong/core";
import { createAuthDatabase, type AuthDatabase } from "./client.js";
import { memberships, promptVersions, users, workspaces, workspaceInvites } from "./schema.js";
import { OPAK_OPERATOR_ID, OPAK_PROMPT_KEY, OPAK_PROMPT_VERSION, OPAK_WORKSPACE_ID, opakProfile, opakPromptTemplate } from "./seeds/opak-profile.js";

function parseEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("OPAK_OPERATOR_EMAIL must be a valid email");
  }
  return email;
}
export type OpakSeedStore = {
  upsertWorkspace(input: { id: string; name: string; profile: WorkspaceProfile }): Promise<string>;
  upsertUser(input: { id: string; email: string }): Promise<string>;
  upsertMembership(input: { workspaceId: string; userId: string; role: "operator" }): Promise<void>;
  upsertProfile(input: { workspaceId: string; profile: WorkspaceProfile }): Promise<void>;
  upsertPromptVersion(input: { workspaceId: string; key: string; version: number; template: string; model: string }): Promise<void>;
  upsertInvite(input: { workspaceId: string; email: string; role: "operator"; status: "pending" }): Promise<void>;
};
export type OpakSeedResult = { workspaceId: string; userId: string; email: string; promptVersion: number };

export async function seedOpak(store: OpakSeedStore, operatorEmail: string): Promise<OpakSeedResult> {
  const email = parseEmail(operatorEmail);
  const workspaceId = await store.upsertWorkspace({ id: OPAK_WORKSPACE_ID, name: opakProfile.name, profile: opakProfile });
  const userId = await store.upsertUser({ id: OPAK_OPERATOR_ID, email });
  await store.upsertMembership({ workspaceId, userId, role: "operator" });
  await store.upsertProfile({ workspaceId, profile: opakProfile });
  await store.upsertPromptVersion({ workspaceId, key: OPAK_PROMPT_KEY, version: OPAK_PROMPT_VERSION, template: opakPromptTemplate, model: process.env.OPENAI_MODEL ?? "gpt-5.6-terra" });
  await store.upsertInvite({ workspaceId, email, role: "operator", status: "pending" });
  return { workspaceId, userId, email, promptVersion: OPAK_PROMPT_VERSION };
}

export function createOpakSeedStore(db: AuthDatabase): OpakSeedStore {
  return {
    async upsertWorkspace(input) {
      await db.insert(workspaces).values({ id: input.id, name: input.name, profile: input.profile }).onConflictDoUpdate({ target: workspaces.id, set: { name: input.name, profile: input.profile } });
      return input.id;
    },
    async upsertUser(input) {
      await db.insert(users).values({ id: input.id, email: input.email }).onConflictDoUpdate({ target: users.id, set: { email: input.email } });
      return input.id;
    },
    async upsertMembership(input) {
      await db.insert(memberships).values({ workspaceId: input.workspaceId, userId: input.userId, role: input.role }).onConflictDoUpdate({ target: [memberships.workspaceId, memberships.userId], set: { role: input.role } });
    },
    async upsertProfile(input) {
      await db.update(workspaces).set({ profile: input.profile }).where(eq(workspaces.id, input.workspaceId));
    },
    async upsertPromptVersion(input) {
      await db.insert(promptVersions).values({ workspaceId: input.workspaceId, key: input.key, version: input.version, template: input.template, model: input.model }).onConflictDoUpdate({ target: [promptVersions.workspaceId, promptVersions.key, promptVersions.version], set: { template: input.template, model: input.model } });
    },
    async upsertInvite(input) {
      await db.insert(workspaceInvites).values(input).onConflictDoUpdate({ target: [workspaceInvites.workspaceId, workspaceInvites.email], set: { role: input.role, status: input.status } });
    },
  };
}

export async function seedOpakFromEnv(): Promise<OpakSeedResult> {
  const email = process.env.OPAK_OPERATOR_EMAIL;
  if (!email) throw new Error("OPAK_OPERATOR_EMAIL is required");
  const url = process.env.DATABASE_ADMIN_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  const db = createAuthDatabase(url);
  try { return await seedOpak(createOpakSeedStore(db), email); } finally { await db.close(); }
}

export { opakProfile } from "./seeds/opak-profile.js";


if (process.argv[1]?.replaceAll("\\", "/").endsWith("/seed-opak.ts")) {
  await seedOpakFromEnv();
}
