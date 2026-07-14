export type SessionContext = {
  workspaceId: string;
  actorId: string;
  role: "viewer" | "operator" | "reviewer" | "admin" | "owner";
};

export interface SessionContextPort {
  resolve(): Promise<SessionContext | null>;
}

export class SessionContextUnavailableError extends Error {
  constructor() {
    super("Session context is not configured");
    this.name = "SessionContextUnavailableError";
  }
}

export const failClosedSessionContext: SessionContextPort = {
  async resolve(): Promise<never> {
    throw new SessionContextUnavailableError();
  },
};
