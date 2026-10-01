export type AdminHistoryHost = {
  history: Pick<History, "state" | "pushState" | "replaceState" | "go">;
  location: { href: string };
  getIndex(): number | undefined;
  dispatchPopState(state: unknown): void;
  addEventListener(
    name: "popstate",
    listener: (event: PopStateEvent) => void,
  ): void;
  removeEventListener(
    name: "popstate",
    listener: (event: PopStateEvent) => void,
  ): void;
};
const MARKER = "__wukongAdminHistory";
/** Restore a refused traversal, then replay it only after the form guard agrees.
 * No sentinel/push entries are created, so repeated Stay never grows history.
 * The browser host uses the beforeInteractive bridge: Window popstate runs at
 * the target in registration order, so a late capture listener is insufficient.
 */
export function installAdminHistoryGuard(
  host: AdminHistoryHost,
  dirty: () => boolean,
  request: (delta: number) => void,
) {
  let scope = crypto.randomUUID();
  const push = host.history.pushState;
  const replace = host.history.replaceState;
  const markerIndex = (state: unknown): number | undefined => {
    const marker = (state as Record<string, any> | null)?.[MARKER];
    return marker?.scope === scope && Number.isInteger(marker.index)
      ? marker.index
      : undefined;
  };
  const nativeIndex = () => {
    const index = host.getIndex();
    return Number.isInteger(index) ? index : undefined;
  };
  let current = {
    href: host.location.href,
    index: nativeIndex() ?? 0,
    state: host.history.state,
  };
  const stamped = (state: unknown, index: number) => ({
    ...(state && typeof state === "object" ? state : {}),
    [MARKER]: { scope, index },
  });
  replace.call(
    host.history,
    stamped(host.history.state, current.index),
    "",
    current.href,
  );
  current.state = host.history.state;
  const patchedPush: History["pushState"] = function (state, title, url) {
    const index = current.index + 1;
    push.call(host.history, stamped(state, index), title, url);
    current = {
      href: host.location.href,
      index: nativeIndex() ?? index,
      state: host.history.state,
    };
  };
  const patchedReplace: History["replaceState"] = function (state, title, url) {
    replace.call(host.history, stamped(state, current.index), title, url);
    current = {
      href: host.location.href,
      index: nativeIndex() ?? current.index,
      state: host.history.state,
    };
  };
  host.history.pushState = patchedPush;
  host.history.replaceState = patchedReplace;
  let restoring: { href: string; index: number; delta: number } | null = null;
  let approvedDelta: number | null = null;
  let unknownDestination: { href: string; state: unknown } | null = null;
  const holdUnknown = (event: PopStateEvent) => {
    event.stopImmediatePropagation();
    unknownDestination = { href: host.location.href, state: event.state };
    // An unindexed entry has no trustworthy direction or distance. Preserve the
    // draft at the reached position rather than guessing history.go(). Rotate
    // the marker scope so earlier markers cannot imply a false stack position.
    scope = crypto.randomUUID();
    current.index = 0;
    replace.call(host.history, stamped(current.state, 0), "", current.href);
    current.state = host.history.state;
    restoring = null;
    request(0);
  };
  const pop = (event: PopStateEvent) => {
    const index = nativeIndex() ?? markerIndex(event.state);
    if (approvedDelta !== null) {
      approvedDelta = null;
      current = {
        href: host.location.href,
        index: index ?? 0,
        state: host.history.state,
      };
      return;
    }
    if (restoring) {
      if (index === undefined) {
        holdUnknown(event);
        return;
      }
      event.stopImmediatePropagation();
      if (host.location.href === restoring.href && index === restoring.index) {
        const attempt = restoring;
        restoring = null;
        current = {
          href: attempt.href,
          index: attempt.index,
          state: host.history.state,
        };
        request(attempt.delta);
      } else host.history.go(restoring.index - index);
      return;
    }
    if (!dirty()) {
      current = {
        href: host.location.href,
        index: index ?? 0,
        state: host.history.state,
      };
      return;
    }
    if (index === undefined) {
      holdUnknown(event);
      return;
    }
    const delta = index - current.index;
    if (delta === 0) return;
    event.stopImmediatePropagation();
    unknownDestination = null;
    restoring = { ...current, delta };
    host.history.go(-delta);
  };
  host.addEventListener("popstate", pop);
  return {
    leave(delta: number) {
      if (delta === 0 && unknownDestination) {
        const destination = unknownDestination;
        unknownDestination = null;
        approvedDelta = 0;
        replace.call(host.history, destination.state, "", destination.href);
        host.dispatchPopState(destination.state);
      } else {
        approvedDelta = delta;
        host.history.go(delta);
      }
    },
    dispose() {
      host.removeEventListener("popstate", pop);
      if (host.history.pushState === patchedPush) host.history.pushState = push;
      if (host.history.replaceState === patchedReplace)
        host.history.replaceState = replace;
    },
  };
}
