// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import {
  requestClientContextChange,
  subscribeClientContextChangeGuard,
  type ClientContextChangeRequest,
} from "./client-context-change-guard";
describe("client context change admission", () => {
  it("holds work until one approval, and Stay performs no work", async () => {
    const host = new EventTarget(),
      work = vi.fn().mockResolvedValue(undefined);
    let pending!: ClientContextChangeRequest;
    const dispose = subscribeClientContextChangeGuard(
      () => true,
      (request) => {
        pending = request;
      },
      host,
    );
    const first = requestClientContextChange(
      { kind: "workspace", workspaceId: "second" },
      work,
      { host },
    );
    expect(work).not.toHaveBeenCalled();
    pending.cancel();
    expect(await first).toBe(false);
    pending.approve();
    expect(work).not.toHaveBeenCalled();
    const second = requestClientContextChange(
      { kind: "workspace", workspaceId: "second" },
      work,
      { host },
    );
    pending.approve();
    pending.approve();
    expect(await second).toBe(true);
    expect(work).toHaveBeenCalledTimes(1);
    dispose();
  });
  it("cancels retained callbacks on unmount, abort and replacement", async () => {
    const host = new EventTarget(),
      work = vi.fn().mockResolvedValue(undefined),
      requests: ClientContextChangeRequest[] = [];
    const dispose = subscribeClientContextChangeGuard(
      () => true,
      (request) => requests.push(request),
      host,
    );
    const abort = new AbortController(),
      first = requestClientContextChange(
        { kind: "workspace", workspaceId: "first" },
        work,
        { host, signal: abort.signal },
      );
    abort.abort();
    expect(await first).toBe(false);
    const second = requestClientContextChange(
      { kind: "workspace", workspaceId: "second" },
      work,
      { host },
    );
    dispose();
    expect(await second).toBe(false);
    for (const request of requests) request.approve();
    expect(work).not.toHaveBeenCalled();
  });
  it("does not let retired subscription cleanup cancel a newer owner", async () => {
    const host = new EventTarget(),
      work = vi.fn().mockResolvedValue(undefined);
    let pending!: ClientContextChangeRequest;
    const old = subscribeClientContextChangeGuard(
      () => true,
      () => {},
      host,
    );
    old();
    const current = subscribeClientContextChangeGuard(
      () => true,
      (request) => {
        pending = request;
      },
      host,
    );
    const result = requestClientContextChange(
      { kind: "workspace", workspaceId: "second" },
      work,
      { host },
    );
    old();
    pending.approve();
    expect(await result).toBe(true);
    expect(work).toHaveBeenCalledOnce();
    current();
  });
  it("passes clean routes immediately and reports failed approved work", async () => {
    const host = new EventTarget();
    const dispose = subscribeClientContextChangeGuard(
      () => false,
      () => {
        throw Error("unexpected");
      },
      host,
    );
    const work = vi.fn().mockResolvedValue(undefined);
    expect(
      await requestClientContextChange(
        { kind: "workspace", workspaceId: "second" },
        work,
        { host },
      ),
    ).toBe(true);
    await expect(
      requestClientContextChange(
        { kind: "workspace", workspaceId: "second" },
        async () => {
          throw Error("safe failure");
        },
        { host },
      ),
    ).rejects.toThrow("safe failure");
    dispose();
  });
  it("keeps accepted work owned through ordinary guard cleanup until completion", async () => {
    const host = new EventTarget();
    let approved!: ClientContextChangeRequest, finish!: () => void;
    const work = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const dispose = subscribeClientContextChangeGuard(
      () => true,
      (request) => {
        approved = request;
      },
      host,
    );
    const settled = vi.fn();
    const result = requestClientContextChange(
      { kind: "workspace", workspaceId: "second" },
      work,
      { host },
    );
    approved.onSettled(settled);
    approved.approve();
    await Promise.resolve();
    dispose();
    approved.cancel();
    approved.approve();
    await Promise.resolve();
    expect(work).toHaveBeenCalledOnce();
    expect(settled).not.toHaveBeenCalled();
    finish();
    expect(await result).toBe(true);
    expect(settled).toHaveBeenCalledExactlyOnceWith("completed");
  });
  it("allows the operation owner's explicit abort to cancel accepted work", async () => {
    const host = new EventTarget(),
      controller = new AbortController();
    let approved!: ClientContextChangeRequest, finish!: () => void;
    const work = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const dispose = subscribeClientContextChangeGuard(
      () => true,
      (request) => {
        approved = request;
      },
      host,
    );
    const result = requestClientContextChange(
      { kind: "workspace", workspaceId: "second" },
      work,
      { host, signal: controller.signal },
    );
    approved.approve();
    await Promise.resolve();
    controller.abort();
    expect(await result).toBe(false);
    finish();
    await Promise.resolve();
    expect(work).toHaveBeenCalledOnce();
    dispose();
  });
});
