"use client";

import { useCallback, useEffect, useState } from "react";

async function responseError(response: Response): Promise<Error> {
  const fallback = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as { message?: string };
    return new Error(body.message || fallback);
  } catch {
    return new Error(fallback);
  }
}

export function AdminSettingsPanel() {
  const [brandBackgroundColor, setBrandBackgroundColor] = useState<
    string | null
  >(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/workspace/settings");
    if (!response.ok) throw await responseError(response);
    const body = (await response.json()) as {
      brandBackgroundColor: string | null;
    };
    setBrandBackgroundColor(body.brandBackgroundColor);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load().catch((loadError) =>
      setError(
        loadError instanceof Error
          ? loadError.message
          : "Unable to load settings.",
      ),
    );
  }, [load]);

  const save = () =>
    (async () => {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        const response = await fetch("/api/workspace/settings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ brandBackgroundColor }),
        });
        if (!response.ok) throw await responseError(response);
        setMessage("設定已儲存 Settings saved");
      } catch (saveError) {
        setError(
          saveError instanceof Error
            ? saveError.message
            : "Unable to save settings.",
        );
      } finally {
        setBusy(false);
      }
    })();

  return (
    <section className="settings-panel" aria-busy={busy}>
      {error ? (
        <p className="inline-warning" role="alert">
          {error}
        </p>
      ) : null}
      {message ? (
        <p className="success-note" role="status">
          {message}
        </p>
      ) : null}
      {loaded ? (
        <>
          <label>
            品牌背景色 Brand background color
            <input
              type="color"
              value={brandBackgroundColor ?? "#ffffff"}
              disabled={busy}
              onChange={(event) => setBrandBackgroundColor(event.target.value)}
            />
          </label>
          <button
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={save}
          >
            儲存 Save
          </button>
        </>
      ) : null}
    </section>
  );
}
