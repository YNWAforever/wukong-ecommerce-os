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
});
