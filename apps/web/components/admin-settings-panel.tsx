"use client";
import { WorkspacePolicyPanel } from "./workspace-policy-panel";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAdminDirtyGuard } from "../lib/admin-dirty-context";
import {
  publishSettingsFence,
  useSettingsFence,
} from "../lib/workspace-settings-fence";
type Settings = { brandBackgroundColor: string | null; digest: string };
async function read(response: Response): Promise<Settings> {
  const body = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(body.message || `Request failed (${response.status})`),
      { conflict: response.status === 409 },
    );
  return body;
}
export function AdminSettingsPanel() {
  const [baseline, setBaseline] = useState<Settings | null>(null);
  const [brandBackgroundColor, setColor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const digestRef = useRef<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [comparison, setComparison] = useState<Settings | null>(null);
  const load = useCallback(async () => {
    const next = await read(await fetch("/api/workspace/settings"));
    digestRef.current = next.digest;
    setBaseline(next);
    setColor(next.brandBackgroundColor);
    setError(null);
    setConflict(false);
    setComparison(null);
  }, []);
  useEffect(() => {
    load().catch((e) =>
      setError(e instanceof Error ? e.message : "Unable to load settings."),
    );
  }, [load]);
  useSettingsFence(
    useCallback((previous, next) => {
      if (digestRef.current === previous) digestRef.current = next;
      setBaseline((current) =>
        current?.digest === previous ? { ...current, digest: next } : current,
      );
    }, []),
  );
  const save = async () => {
    if (submitting.current || !baseline) return false;
    submitting.current = true;
    const expectedDigest = digestRef.current ?? baseline.digest;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const next = await read(
        await fetch("/api/workspace/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ brandBackgroundColor, expectedDigest }),
        }),
      );
      publishSettingsFence(expectedDigest, next.digest);
      digestRef.current = next.digest;
      setBaseline(next);
      setColor(next.brandBackgroundColor);
      setConflict(false);
      setComparison(null);
      setMessage("設定已儲存 Settings saved");
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Unable to save settings.");
      setConflict(Boolean((e as { conflict?: boolean }).conflict));
      return false;
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  };
  useAdminDirtyGuard("brand-settings", {
    dirty: Boolean(
      baseline &&
      (brandBackgroundColor !== baseline.brandBackgroundColor || busy),
    ),
    save,
    discard() {
      setColor(baseline?.brandBackgroundColor ?? null);
      setError(null);
      setConflict(false);
      setComparison(null);
    },
  });
  return (
    <>
      <section className="settings-panel" aria-busy={busy}>
        {error && (
          <p className="inline-warning" role="alert">
            {error}
          </p>
        )}
        {message && (
          <p className="success-note" role="status">
            {message}
          </p>
        )}
        {conflict && (
          <div>
            <p>
              另一位管理員已更新。請比較或重新載入；不會覆寫。 Another
              administrator updated settings. Compare or reload before saving.
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={async () => {
                try {
                  setComparison(
                    await read(await fetch("/api/workspace/settings")),
                  );
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              比較最新設定 Compare latest settings
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                load().catch((e) => setError((e as Error).message))
              }
            >
              重新載入並捨棄我的修改 Reload and discard my edits
            </button>
            {comparison && (
              <p>
                我的背景色 My color: {brandBackgroundColor ?? "Default"} ·
                最新背景色 Latest color:{" "}
                {comparison.brandBackgroundColor ?? "Default"}
              </p>
            )}
          </div>
        )}
        {baseline && (
          <>
            <label>
              品牌背景色 Brand background color
              <input
                type="color"
                value={brandBackgroundColor ?? "#ffffff"}
                disabled={busy}
                onChange={(event) => setColor(event.target.value)}
              />
            </label>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void save()}
            >
              儲存 Save
            </button>
          </>
        )}
      </section>
      <WorkspacePolicyPanel />
    </>
  );
}
