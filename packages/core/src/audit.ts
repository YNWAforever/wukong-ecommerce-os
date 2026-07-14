export type AuditContext = {
  workspaceId: string;
  actorId: string;
  entityId: string;
};

export type DomainAuditEvent = AuditContext & {
  action: string;
  metadata: Record<string, unknown>;
};

export type AuditWriter = {
  write(event: DomainAuditEvent): Promise<void>;
};
