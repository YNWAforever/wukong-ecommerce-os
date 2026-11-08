// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

import { StudioComposer } from "./studio-composer";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

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
  return container.querySelector(
    "button",
  ) as HTMLButtonElement;
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
