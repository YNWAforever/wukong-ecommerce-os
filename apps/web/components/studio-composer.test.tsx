// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { StudioComposerAttachment } from "../lib/studio/attachments";
import { StudioComposer } from "./studio-composer";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

type HarnessProps = {
  initial?: string;
  sending?: boolean;
  error?: Parameters<typeof StudioComposer>[0]["error"];
  sendDisabled?: boolean;
  sendDisabledReason?: Parameters<
    typeof StudioComposer
  >[0]["sendDisabledReason"];
  skillKey?: string | null;
  onSend?: () => void;
  onRetry?: () => void;
  onClearSkill?: () => void;
  disabled?: boolean;
  attachments?: readonly StudioComposerAttachment[];
  onAttachFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  onRetryAttachment?: (id: string) => void;
  attachmentNotice?: Parameters<typeof StudioComposer>[0]["attachmentNotice"];
};

function Harness(props: HarnessProps) {
  const [value, setValue] = useState(props.initial ?? "");
  return (
    <StudioComposer
      locale="en"
      id="composer-test"
      value={value}
      onChange={setValue}
      onSend={props.onSend ?? (() => undefined)}
      onRetry={props.onRetry}
      sending={props.sending ?? false}
      error={props.error ?? null}
      disabled={props.disabled ?? false}
      sendDisabled={props.sendDisabled ?? false}
      sendDisabledReason={props.sendDisabledReason ?? null}
      skillKey={props.skillKey ?? null}
      onClearSkill={props.onClearSkill}
      attachments={props.attachments ?? []}
      {...(props.onAttachFiles ? { onAttachFiles: props.onAttachFiles } : {})}
      {...(props.onRemoveAttachment
        ? { onRemoveAttachment: props.onRemoveAttachment }
        : {})}
      {...(props.onRetryAttachment
        ? { onRetryAttachment: props.onRetryAttachment }
        : {})}
      attachmentNotice={props.attachmentNotice ?? null}
    />
  );
}

const roots: ReturnType<typeof createRoot>[] = [];

async function mount(props: HarnessProps = {}) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => {
    root.render(<Harness {...props} />);
  });
  return container;
}

function textarea(container: HTMLElement): HTMLTextAreaElement {
  return container.querySelector("textarea") as HTMLTextAreaElement;
}

function sendButton(container: HTMLElement): HTMLButtonElement {
  return container.querySelector("button") as HTMLButtonElement;
}

async function type(container: HTMLElement, value: string) {
  const input = textarea(container);
  await act(async () => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await act(async () => root.unmount());
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("StudioComposer", () => {
  it("renders a bounded textarea, the permanent disclaimer and disabled actions", async () => {
    const container = await mount();

    expect(textarea(container).maxLength).toBe(2000);
    expect(container.textContent).toContain(
      "AI may be wrong; verify important numbers.",
    );
    expect(container.textContent).toContain("Enter a message first.");

    const buttons = Array.from(container.querySelectorAll("button"));
    expect(buttons).toHaveLength(2);
    for (const button of buttons) expect(button.disabled).toBe(true);
    expect(container.textContent).toContain("Attach files");
  });

  it("enables Send when there is a non-empty draft and calls onSend", async () => {
    const onSend = vi.fn();
    const container = await mount({ onSend });

    await type(container, "Find the synthetic listings");
    const send = sendButton(container);
    expect(send.disabled).toBe(false);

    await act(async () => send.click());
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("sends on Enter and keeps Shift+Enter as a newline", async () => {
    const onSend = vi.fn();
    const container = await mount({ initial: "hello", onSend });

    await act(async () => {
      textarea(container).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          shiftKey: true,
          bubbles: true,
        }),
      );
    });
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => {
      textarea(container).dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
      );
    });
    expect(onSend).toHaveBeenCalledTimes(1);
  });

  it("does not send an Enter that confirms an IME composition", async () => {
    const onSend = vi.fn();
    const container = await mount({ initial: "商品", onSend });

    await act(async () => {
      textarea(container).dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Enter",
          isComposing: true,
          bubbles: true,
        }),
      );
    });

    expect(onSend).not.toHaveBeenCalled();
  });

  it("disables Send and says it is working while a turn is in flight", async () => {
    const container = await mount({ initial: "hello", sending: true });

    expect(sendButton(container).disabled).toBe(true);
    expect(container.textContent).toContain("Working…");
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();
  });

  it("states the viewer role reason instead of letting a send silently fail", async () => {
    const container = await mount({
      initial: "hello",
      sendDisabled: true,
      sendDisabledReason: "studio.composer.viewerNote",
    });

    expect(sendButton(container).disabled).toBe(true);
    expect(container.textContent).toContain(
      "Your role can read only; sending requires operator or higher.",
    );
    // Typing stays possible; only sending is refused.
    expect(textarea(container).disabled).toBe(false);
  });

  it("shows the skill chip with a clear action", async () => {
    const onClearSkill = vi.fn();
    const container = await mount({
      skillKey: "catalog.find",
      onClearSkill,
    });

    expect(container.textContent).toContain("Selected skill");
    expect(container.textContent).toContain("catalog.find");
    const clear = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Clear skill",
    ) as HTMLButtonElement;
    await act(async () => clear.click());
    expect(onClearSkill).toHaveBeenCalledTimes(1);
  });

  it("keeps the draft and offers Retry after a failed send", async () => {
    const onRetry = vi.fn();
    const container = await mount({
      initial: "keep this exact draft",
      error: "studio.error.network",
      onRetry,
    });

    expect(textarea(container).value).toBe("keep this exact draft");
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Could not reach the server");
    const retry = alert?.querySelector("button");
    expect(retry?.textContent).toBe("Retry send");
    await act(async () => (retry as HTMLButtonElement).click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe("StudioComposer attachments", () => {
  function fileInput(container: HTMLElement): HTMLInputElement {
    const input = container.querySelector('input[type="file"]');
    if (!(input instanceof HTMLInputElement)) throw new Error("no file input");
    return input;
  }

  function attachButton(container: HTMLElement): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
      (candidate) => candidate.textContent === "Attach files",
    );
    if (!(button instanceof HTMLButtonElement)) throw new Error("no attach");
    return button;
  }

  async function choose(container: HTMLElement, files: File[]) {
    const input = fileInput(container);
    Object.defineProperty(input, "files", {
      value: files,
      configurable: true,
    });
    await act(async () => {
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  it("enables Attach only when an upload handler is wired, with the reviewed accept list", async () => {
    const withoutHandler = await mount();
    expect(attachButton(withoutHandler).disabled).toBe(true);

    const onAttachFiles = vi.fn();
    const container = await mount({ onAttachFiles });
    expect(attachButton(container).disabled).toBe(false);
    const input = fileInput(container);
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe(
      "image/jpeg,image/png,image/webp,application/pdf",
    );

    const files = [
      new File(["a"], "photo.png", { type: "image/png" }),
      new File(["b"], "sheet.pdf", { type: "application/pdf" }),
    ];
    await choose(container, files);
    expect(onAttachFiles).toHaveBeenCalledTimes(1);
    expect(
      (onAttachFiles.mock.calls[0]?.[0] as File[]).map((entry) => entry.name),
    ).toEqual(["photo.png", "sheet.pdf"]);
  });

  it("renders every attachment state with remove and retry where useful", async () => {
    const onRemoveAttachment = vi.fn();
    const onRetryAttachment = vi.fn();
    const attachments: StudioComposerAttachment[] = [
      {
        id: "a1",
        fileName: "uploading.png",
        state: "uploading",
        errorKey: null,
        assetId: null,
      },
      {
        id: "a2",
        fileName: "done.png",
        state: "uploaded",
        errorKey: null,
        assetId: "asset_1",
      },
      {
        id: "a3",
        fileName: "bad.png",
        state: "failed",
        errorKey: "studio.composer.attachment.failed",
        assetId: null,
      },
      {
        id: "a4",
        fileName: "stopped.png",
        state: "cancelled",
        errorKey: "studio.composer.attachment.cancelled",
        assetId: null,
      },
      {
        id: "a5",
        fileName: "notes.txt",
        state: "unsupported_type",
        errorKey: "studio.composer.attachment.unsupported",
        assetId: null,
      },
      {
        id: "a6",
        fileName: "huge.png",
        state: "too_large",
        errorKey: "studio.composer.attachment.tooLarge",
        assetId: null,
      },
    ];
    const container = await mount({
      initial: "hello",
      attachments,
      onRemoveAttachment,
      onRetryAttachment,
    });

    expect(container.textContent).toContain("Uploading…");
    expect(container.textContent).toContain("Uploaded");
    expect(container.textContent).toContain(
      "This file could not be uploaded. Try again.",
    );
    expect(container.textContent).toContain("Upload cancelled.");
    expect(container.textContent).toContain(
      "Unsupported file type. Use JPG, PNG, WebP or PDF.",
    );
    expect(container.textContent).toContain(
      "The file is larger than the 20 MB limit.",
    );

    const retryButtons = Array.from(
      container.querySelectorAll("button"),
    ).filter((button) => button.textContent === "Retry upload");
    expect(retryButtons).toHaveLength(2);
    await act(async () => (retryButtons[0] as HTMLButtonElement).click());
    expect(onRetryAttachment).toHaveBeenCalledWith("a3");

    const removeButtons = Array.from(
      container.querySelectorAll("button"),
    ).filter((button) => button.textContent === "Remove");
    expect(removeButtons).toHaveLength(6);
    await act(async () => (removeButtons[1] as HTMLButtonElement).click());
    expect(onRemoveAttachment).toHaveBeenCalledWith("a2");
  });

  it("blocks Send while a file is still uploading and explains why", async () => {
    const container = await mount({
      initial: "hello",
      attachments: [
        {
          id: "a1",
          fileName: "photo.png",
          state: "uploading",
          errorKey: null,
          assetId: null,
        },
      ],
    });

    expect(sendButton(container).disabled).toBe(true);
    expect(container.textContent).toContain(
      "Wait for uploads to finish, or remove the files still in progress.",
    );
  });

  it("disables Attach while sending and states the read-only reason", async () => {
    const sending = await mount({ sending: true, onAttachFiles: vi.fn() });
    expect(attachButton(sending).disabled).toBe(true);

    const readOnly = await mount({
      sendDisabled: true,
      onAttachFiles: vi.fn(),
    });
    const button = attachButton(readOnly);
    expect(button.disabled).toBe(true);
    expect(button.title).toContain(
      "Attaching files requires operator or higher.",
    );
  });

  it("shows an honest elapsed counter and progress note while sending", async () => {
    vi.useFakeTimers();
    try {
      const container = await mount({ sending: true, initial: "hello" });
      expect(container.textContent).toContain("Working…");
      expect(container.textContent).toContain("Deterministic answer first");
      expect(container.textContent).not.toContain(" · 1s");
      await act(async () => {
        vi.advanceTimersByTime(3000);
      });
      expect(container.textContent).toContain("Working… · 3s");
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows the attachment limit notice", async () => {
    const container = await mount({
      onAttachFiles: vi.fn(),
      attachmentNotice: "studio.composer.attachment.limit",
    });
    expect(container.textContent).toContain("Up to 8 files can be attached.");
  });
});
