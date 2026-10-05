import { afterEach, describe, expect, it, vi } from "vitest";

import { createAuthEmailSender } from "./auth-mailer";

describe("auth mailer", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("rejects evaluation in a browser environment", async () => {
    vi.stubGlobal("window", {});
    vi.resetModules();

    await expect(import("./auth-mailer")).rejects.toThrow("server-only");
  });

  it("uses the configured SMTP URL and sender without printing credentials", async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: "message-1" });
    const createTransport = vi.fn(() => ({ sendMail }));
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const send = createAuthEmailSender({
      createTransport,
      env: {
        AUTH_SMTP_URL: "smtps://resend:secret@smtp.resend.com:465",
        AUTH_EMAIL_FROM: "Wukong Auth <auth@example.com>",
      },
    });

    await send({
      to: "admin@example.com",
      subject: "Sign in",
      text: "Open the link",
      html: "<p>Open the link</p>",
    });

    expect(createTransport).toHaveBeenCalledWith(
      "smtps://resend:secret@smtp.resend.com:465",
    );
    expect(sendMail).toHaveBeenCalledWith({
      from: "Wukong Auth <auth@example.com>",
      to: "admin@example.com",
      subject: "Sign in",
      text: "Open the link",
      html: "<p>Open the link</p>",
    });
    expect(log).toHaveBeenCalledTimes(1);
    const deliveryLog = String(log.mock.calls[0]?.[0]);
    expect(deliveryLog).toContain("auth_email_accepted");
    expect(deliveryLog).not.toContain("admin@example.com");
    expect(deliveryLog).not.toContain("secret");
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("fails closed when SMTP configuration is unavailable", async () => {
    const createTransport = vi.fn();
    const report = vi.fn();
    const send = createAuthEmailSender({ createTransport, env: {}, report });

    await expect(
      send({
        to: "admin@example.com",
        subject: "Sign in",
        text: "Open",
        html: "<p>Open</p>",
      }),
    ).rejects.toThrow("Authentication email is not configured");
    expect(createTransport).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        outcome: "rejected",
        errorName: "AuthEmailConfigurationError",
      }),
    );
  });

  it("reports safe SMTP acceptance and rejection metadata without recipient or credentials", async () => {
    const report = vi.fn();
    const sendMail = vi
      .fn()
      .mockResolvedValueOnce({ messageId: "message-1" })
      .mockRejectedValueOnce(
        Object.assign(new Error("authentication failed with secret"), {
          code: "EAUTH",
          responseCode: 535,
        }),
      );
    const send = createAuthEmailSender({
      createTransport: () => ({ sendMail }),
      env: {
        AUTH_SMTP_URL: "smtps://resend:secret@smtp.resend.com:465",
        AUTH_EMAIL_FROM: "Wukong Auth <auth@example.com>",
      },
      report,
    });
    const email = {
      to: "admin@example.com",
      subject: "Sign in",
      text: "Open",
      html: "<p>Open</p>",
    };

    await send(email);
    await expect(send(email)).rejects.toThrow("authentication failed");

    expect(report).toHaveBeenNthCalledWith(1, { outcome: "accepted" });
    expect(report).toHaveBeenNthCalledWith(2, {
      outcome: "rejected",
      errorName: "Error",
      code: "EAUTH",
      responseCode: 535,
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain(
      "admin@example.com",
    );
    expect(JSON.stringify(report.mock.calls)).not.toContain("secret");
  });

  it.each([
    "admin@example.com",
    "person@resend.dev",
    "delivered@resend.dev.example.com",
    "delivered@other.example",
    "Name <delivered@resend.dev>",
    "delivered@resend.dev,admin@example.com",
    "delivered@resend.dev\r\nBcc: admin@example.com",
    "suppressed+label@resend.dev",
    "delivered+@resend.dev",
    "delivered@resend.dev\n",
    "delivered@resend.dev\r",
    "delivered@resend.dev\u2028",
  ])("blocks non-test Resend recipients in Preview: %s", async (to) => {
    const sendMail = vi.fn();
    const createTransport = vi.fn(() => ({ sendMail }));
    const report = vi.fn();
    const send = createAuthEmailSender({
      createTransport,
      env: {
        AUTH_SMTP_URL: "smtps://resend:synthetic-secret@SMTP.RESEND.COM:465",
        AUTH_EMAIL_FROM: "Wukong Staging <onboarding@resend.dev>",
        VERCEL_ENV: "preview",
        AUTH_EMAIL_DELIVERY_MODE: "resend-test",
      },
      report,
    });

    await expect(
      send({
        to,
        subject: "Synthetic",
        text: "Synthetic token",
        html: "<p>Synthetic token</p>",
      }),
    ).rejects.toThrow(
      "Preview auth email recipient is not a Resend test address",
    );
    expect(createTransport).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith({
      outcome: "rejected",
      errorName: "AuthEmailRecipientError",
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain(to);
    expect(JSON.stringify(report.mock.calls)).not.toContain("synthetic-secret");
    expect(JSON.stringify(report.mock.calls)).not.toContain("Synthetic token");
  });

  it.each([
    "delivered@resend.dev",
    "delivered+opak-admin@resend.dev",
    "delivered+opak-operator@resend.dev",
    "delivered+opak-reviewer@resend.dev",
    "bounced+opak-test@resend.dev",
    "complained@resend.dev",
    "suppressed@resend.dev",
  ])(
    "allows the official Resend simulator address in Preview: %s",
    async (to) => {
      const sendMail = vi.fn().mockResolvedValue({});
      const send = createAuthEmailSender({
        createTransport: () => ({ sendMail }),
        env: {
          AUTH_SMTP_URL: "smtps://resend:synthetic-secret@smtp.resend.com:465",
          AUTH_EMAIL_FROM: "Wukong Staging <onboarding@resend.dev>",
          VERCEL_ENV: "preview",
          AUTH_EMAIL_DELIVERY_MODE: "resend-test",
        },
        report: vi.fn(),
      });
      await send({
        to,
        subject: "Synthetic",
        text: "Synthetic",
        html: "<p>Synthetic</p>",
      });
      expect(sendMail).toHaveBeenCalledOnce();
      expect(sendMail.mock.calls[0]?.[0].to).toBe(to);
    },
  );

  it("preserves production Resend recipient behavior", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const send = createAuthEmailSender({
      createTransport: () => ({ sendMail }),
      env: {
        AUTH_SMTP_URL: "smtps://resend:synthetic-secret@smtp.resend.com:465",
        AUTH_EMAIL_FROM: "Wukong Auth <auth@example.com>",
        VERCEL_ENV: "production",
      },
      report: vi.fn(),
    });
    await send({
      to: "admin@example.com",
      subject: "Synthetic",
      text: "Synthetic",
      html: "<p>Synthetic</p>",
    });
    expect(sendMail.mock.calls[0]?.[0].to).toBe("admin@example.com");
  });

  it("preserves capture-SMTP recipients in Preview", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const send = createAuthEmailSender({
      createTransport: () => ({ sendMail }),
      env: {
        AUTH_SMTP_URL: "smtp://mailpit.example.test:1025",
        AUTH_EMAIL_FROM: "Wukong Staging <no-reply@example.invalid>",
        VERCEL_ENV: "preview",
      },
      report: vi.fn(),
    });
    await send({
      to: "admin@example.invalid",
      subject: "Synthetic",
      text: "Synthetic",
      html: "<p>Synthetic</p>",
    });
    expect(sendMail.mock.calls[0]?.[0].to).toBe("admin@example.invalid");
  });

  it("rejects malformed Preview SMTP before opening a transport", async () => {
    const createTransport = vi.fn();
    const report = vi.fn();
    const send = createAuthEmailSender({
      createTransport,
      env: {
        AUTH_SMTP_URL: "PENDING_SAFE_SMTP_SANDBOX",
        AUTH_EMAIL_FROM: "Staging",
        VERCEL_ENV: "preview",
        AUTH_EMAIL_DELIVERY_MODE: "resend-test",
      },
      report,
    });
    await expect(
      send({
        to: "delivered@resend.dev",
        subject: "Synthetic",
        text: "Synthetic",
        html: "<p>Synthetic</p>",
      }),
    ).rejects.toThrow("Authentication email is not configured");
    expect(createTransport).not.toHaveBeenCalled();
    expect(report).toHaveBeenCalledWith({
      outcome: "rejected",
      errorName: "AuthEmailConfigurationError",
    });
    expect(JSON.stringify(report.mock.calls)).not.toContain(
      "PENDING_SAFE_SMTP_SANDBOX",
    );
  });

  it.each([
    "smtps://resend:synthetic-secret@smtp.resend.com.:465",
    "smtps://resend:synthetic-secret@%73mtp.resend.com:465",
    "smtps://resend:synthetic-secret@smtp。resend。com:465",
    "smtps://resend:synthetic-secret@smtp．resend．com:465",
    "smtps://resend:synthetic-secret@capture.example.test:465?service=Resend",
  ])(
    "enforces Resend test mode independently of transport host: %s",
    async (smtpUrl) => {
      const createTransport = vi.fn(() => ({ sendMail: vi.fn() }));
      const report = vi.fn();
      const send = createAuthEmailSender({
        createTransport,
        report,
        env: {
          AUTH_SMTP_URL: smtpUrl,
          AUTH_EMAIL_FROM: "Staging",
          VERCEL_ENV: "preview",
          AUTH_EMAIL_DELIVERY_MODE: "resend-test",
        },
      });
      await expect(
        send({
          to: "admin@example.com",
          subject: "Synthetic",
          text: "Synthetic token",
          html: "<p>Synthetic token</p>",
        }),
      ).rejects.toThrow(
        "Preview auth email recipient is not a Resend test address",
      );
      expect(createTransport).not.toHaveBeenCalled();
      expect(JSON.stringify(report.mock.calls)).not.toContain(
        "admin@example.com",
      );
      expect(JSON.stringify(report.mock.calls)).not.toContain(
        "synthetic-secret",
      );
      expect(JSON.stringify(report.mock.calls)).not.toContain(
        "Synthetic token",
      );
    },
  );

  it.each(["production", "development", undefined])(
    "rejects simulator mode outside trusted Preview: %s",
    async (environment) => {
      const createTransport = vi.fn(() => ({ sendMail: vi.fn() }));
      const send = createAuthEmailSender({
        createTransport,
        report: vi.fn(),
        env: {
          AUTH_SMTP_URL: "smtps://resend:synthetic-secret@smtp.resend.com:465",
          AUTH_EMAIL_FROM: "Staging",
          VERCEL_ENV: environment,
          AUTH_EMAIL_DELIVERY_MODE: "resend-test",
        },
      });
      await expect(
        send({
          to: "delivered@resend.dev",
          subject: "Synthetic",
          text: "Synthetic",
          html: "<p>Synthetic</p>",
        }),
      ).rejects.toThrow("Authentication email is not configured");
      expect(createTransport).not.toHaveBeenCalled();
    },
  );

  it("rejects an unknown configured delivery mode before transport", async () => {
    const createTransport = vi.fn(() => ({ sendMail: vi.fn() }));
    const send = createAuthEmailSender({
      createTransport,
      report: vi.fn(),
      env: {
        AUTH_SMTP_URL: "smtps://resend:synthetic-secret@smtp.resend.com:465",
        AUTH_EMAIL_FROM: "Staging",
        VERCEL_ENV: "preview",
        AUTH_EMAIL_DELIVERY_MODE: "typo",
      },
    });
    await expect(
      send({
        to: "delivered@resend.dev",
        subject: "Synthetic",
        text: "Synthetic",
        html: "<p>Synthetic</p>",
      }),
    ).rejects.toThrow("Authentication email is not configured");
    expect(createTransport).not.toHaveBeenCalled();
  });

  it("preserves ordinary Preview delivery when simulator mode is absent", async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const send = createAuthEmailSender({
      createTransport: () => ({ sendMail }),
      report: vi.fn(),
      env: {
        AUTH_SMTP_URL: "smtps://resend:synthetic-secret@smtp.resend.com:465",
        AUTH_EMAIL_FROM: "Staging",
        VERCEL_ENV: "preview",
      },
    });
    await send({
      to: "admin@example.com",
      subject: "Synthetic",
      text: "Synthetic",
      html: "<p>Synthetic</p>",
    });
    expect(sendMail).toHaveBeenCalledOnce();
  });

  it.each([
    "https://smtp.resend.com",
    "smtps://resend:synthetic-secret@smtp.resend.com:465?logger=true&debug=true",
    "smtps://resend:synthetic-secret@smtp.resend.com:465?service=Resend",
    "smtps://resend:synthetic-secret@smtp.resend.com:465?tls.rejectUnauthorized=false",
  ])(
    "rejects unsafe test SMTP URL options before transport: %s",
    async (smtpUrl) => {
      const createTransport = vi.fn(() => ({ sendMail: vi.fn() }));
      const send = createAuthEmailSender({
        createTransport,
        report: vi.fn(),
        env: {
          AUTH_SMTP_URL: smtpUrl,
          AUTH_EMAIL_FROM: "Staging",
          VERCEL_ENV: "preview",
          AUTH_EMAIL_DELIVERY_MODE: "resend-test",
        },
      });
      await expect(
        send({
          to: "delivered@resend.dev",
          subject: "Synthetic",
          text: "Synthetic",
          html: "<p>Synthetic</p>",
        }),
      ).rejects.toThrow("Authentication email is not configured");
      expect(createTransport).not.toHaveBeenCalled();
    },
  );
});
