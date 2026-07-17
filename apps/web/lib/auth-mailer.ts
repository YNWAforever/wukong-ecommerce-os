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
};

export class AuthEmailConfigurationError extends Error {
  constructor() {
    super("Authentication email is not configured");
    this.name = "AuthEmailConfigurationError";
  }
}

export function createAuthEmailSender(
  dependencies: AuthEmailSenderDependencies = {},
): (email: AuthEmail) => Promise<void> {
  const createTransport =
    dependencies.createTransport ??
    (createNodemailerTransport as unknown as CreateTransport);
  const env = dependencies.env ?? process.env;

  return async (email) => {
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
  };
}

export async function sendAuthEmail(email: AuthEmail): Promise<void> {
  await createAuthEmailSender()(email);
}
