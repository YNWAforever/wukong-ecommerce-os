import { createTransport as createNodemailerTransport } from "nodemailer";

if (typeof window !== "undefined") {
  throw new Error("Auth mailer is server-only");
}

export type AuthEmail = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type AuthEmailDeliveryEvent =
  | { outcome: "accepted" }
  | {
      outcome: "rejected";
      errorName: string;
      code?: string;
      responseCode?: number;
    };

type AuthEmailEnvironment = {
  AUTH_SMTP_URL?: string;
  AUTH_EMAIL_FROM?: string;
};

type MailTransport = {
  sendMail(message: AuthEmail & { from: string }): Promise<unknown>;
};

type CreateTransport = (url: string) => MailTransport;

type AuthEmailSenderDependencies = {
  createTransport?: CreateTransport;
  env?: AuthEmailEnvironment;
  report?: (event: AuthEmailDeliveryEvent) => void;
};

export class AuthEmailConfigurationError extends Error {
  constructor() {
    super("Authentication email is not configured");
    this.name = "AuthEmailConfigurationError";
  }
}

function safeRejection(error: unknown): AuthEmailDeliveryEvent {
  const record =
    typeof error === "object" && error !== null
      ? (error as Record<string, unknown>)
      : {};
  const event: AuthEmailDeliveryEvent = {
    outcome: "rejected",
    errorName: error instanceof Error ? error.name : "UnknownError",
  };
  if (typeof record.code === "string") event.code = record.code.slice(0, 64);
  if (typeof record.responseCode === "number")
    event.responseCode = record.responseCode;
  return event;
}

function reportDelivery(event: AuthEmailDeliveryEvent): void {
  const payload = JSON.stringify({
    level: event.outcome === "accepted" ? "info" : "error",
    message: `auth_email_${event.outcome}`,
    ...event,
  });
  if (event.outcome === "accepted") console.log(payload);
  else console.error(payload);
}

export function createAuthEmailSender(
  dependencies: AuthEmailSenderDependencies = {},
): (email: AuthEmail) => Promise<void> {
  const createTransport =
    dependencies.createTransport ??
    (createNodemailerTransport as unknown as CreateTransport);
  const env = dependencies.env ?? process.env;
  const report = dependencies.report ?? reportDelivery;

  return async (email) => {
    try {
      const smtpUrl = env.AUTH_SMTP_URL;
      const from = env.AUTH_EMAIL_FROM;
      if (!smtpUrl || !from) throw new AuthEmailConfigurationError();

      const transport = createTransport(smtpUrl);
      await transport.sendMail({
        from,
        to: email.to,
        subject: email.subject,
        text: email.text,
        html: email.html,
      });
      report({ outcome: "accepted" });
    } catch (error) {
      report(safeRejection(error));
      throw error;
    }
  };
}

export async function sendAuthEmail(email: AuthEmail): Promise<void> {
  await createAuthEmailSender()(email);
}
