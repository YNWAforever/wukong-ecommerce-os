/**
 * Public pilot-intake fields accepted by the marketing handoff route.
 *
 * This is deliberately not a workspace-scoped repository: the sender has no
 * session, workspace or tenant, and the record is internal sales intake rather
 * than operational merchant data. Validation has already happened in the HTTP
 * layer; this type describes the persisted shape only.
 */
export type PilotLeadInput = {
  name: string;
  email: string;
  company: string;
  platforms: string[];
  skuVolume: string | null;
  message: string | null;
  locale: "en" | "zh-Hant";
  source: string;
  consentAt: Date;
  requestIpHash: string | null;
  userAgent: string | null;
};

export type PilotLeadReceipt = {
  id: string;
  createdAt: Date;
};
