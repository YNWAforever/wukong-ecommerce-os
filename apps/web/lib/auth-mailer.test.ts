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
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("fails closed when SMTP configuration is unavailable", async () => {
    const createTransport = vi.fn();
    const send = createAuthEmailSender({ createTransport, env: {} });

    await expect(
      send({
        to: "admin@example.com",
        subject: "Sign in",
        text: "Open",
        html: "<p>Open</p>",
      }),
    ).rejects.toThrow("Authentication email is not configured");
    expect(createTransport).not.toHaveBeenCalled();
  });
});
