"use client";
/** Local admission only. The workspace-select server still verifies session and membership. */
export type ClientContextChange = { kind: "workspace"; workspaceId: string };
export type ContextChangeOutcome = "completed" | "cancelled" | "failed";
export type ClientContextChangeRequest = {
  readonly change: Readonly<ClientContextChange>;
  readonly pending: boolean;
  claim(): boolean;
  approve(): void;
  /** Withdraw pending admission; accepted work remains owned until completion. */
  cancel(): void;
  onSettled(listener: (outcome: ContextChangeOutcome) => void): () => void;
};
const EVENT = "wukong-client-context-change";
const issued = new WeakSet<object>();
export function requestClientContextChange(
  change: ClientContextChange,
  work: () => Promise<void>,
  options: { host?: EventTarget; signal?: AbortSignal } = {},
): Promise<boolean> {
  const host = options.host ?? window;
  return new Promise((resolve, reject) => {
    let state: "pending" | "running" | ContextChangeOutcome = "pending",
      claimed = false;
    const listeners = new Set<(outcome: ContextChangeOutcome) => void>();
    const settle = (outcome: ContextChangeOutcome, error?: unknown) => {
      if (["completed", "cancelled", "failed"].includes(state)) return;
      state = outcome;
      options.signal?.removeEventListener("abort", abort);
      for (const listener of listeners) listener(outcome);
      listeners.clear();
      if (outcome === "failed") reject(error);
      else resolve(outcome === "completed");
    };
    // Only the operation owner can abort accepted work through its signal.
    const abort = () => settle("cancelled");
    const cancel = () => {
      if (state === "pending") abort();
    };
    const request: ClientContextChangeRequest = {
      change: Object.freeze({ ...change }),
      get pending() {
        return state === "pending";
      },
      claim() {
        if (state !== "pending" || claimed) return false;
        claimed = true;
        return true;
      },
      approve() {
        if (state !== "pending" || options.signal?.aborted) return;
        state = "running";
        void Promise.resolve()
          .then(() => (state === "running" ? work() : undefined))
          .then(
            () => settle("completed"),
            (error) => settle("failed", error),
          );
      },
      cancel,
      onSettled(listener) {
        if (
          state === "completed" ||
          state === "cancelled" ||
          state === "failed"
        )
          listener(state);
        else listeners.add(listener);
        return () => listeners.delete(listener);
      },
    };
    issued.add(request);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      abort();
      return;
    }
    host.dispatchEvent(
      new CustomEvent<ClientContextChangeRequest>(EVENT, { detail: request }),
    );
    if (!claimed) request.approve();
  });
}
export function subscribeClientContextChangeGuard(
  shouldGuard: () => boolean,
  onRequest: (request: ClientContextChangeRequest) => void,
  host: EventTarget = window,
): () => void {
  const owned = new Set<ClientContextChangeRequest>();
  const listener = (event: Event) => {
    const request = (event as CustomEvent<ClientContextChangeRequest>).detail;
    if (!request || !issued.has(request) || !shouldGuard() || !request.claim())
      return;
    owned.add(request);
    request.onSettled(() => owned.delete(request));
    try {
      onRequest(request);
    } catch (error) {
      request.cancel();
      throw error;
    }
  };
  host.addEventListener(EVENT, listener);
  return () => {
    host.removeEventListener(EVENT, listener);
    for (const request of owned) request.cancel();
    owned.clear();
  };
}
