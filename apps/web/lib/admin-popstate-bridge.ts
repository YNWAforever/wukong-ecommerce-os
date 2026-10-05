export type AdminPopstateBridge = {
  subscribe(listener: (event: PopStateEvent) => void): () => void;
};

// This static script must execute before Next registers its Window listener.
export const ADMIN_POPSTATE_BRIDGE_SCRIPT = `(() => {
  const key = "__wukongAdminPopstateBridge";
  if (window[key]) return;
  let active = null;
  window[key] = {
    subscribe(listener) {
      active = listener;
      return () => { if (active === listener) active = null; };
    }
  };
  window.addEventListener("popstate", event => { if (active) active(event); }, true);
})();`;
