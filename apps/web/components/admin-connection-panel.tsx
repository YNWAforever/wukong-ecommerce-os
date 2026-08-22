"use client";

import { useCallback, useEffect, useState } from "react";

type Connection = { shopDomain: string; connectedAt: string } | null;

async function responseError(response: Response): Promise<Error> {
  const fallback = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as { message?: string };
    return new Error(body.message || fallback);
  } catch {
    return new Error(fallback);
  }
}

export function AdminConnectionPanel() {
  const [connection, setConnection] = useState<Connection>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [shopDomain, setShopDomain] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [rotating, setRotating] = useState(false);

  const load = useCallback(async () => {
    const response = await fetch("/api/workspace/connection");
    if (!response.ok) throw await responseError(response);
    const body = (await response.json()) as { connection: Connection };
    setConnection(body.connection);
    setLoaded(true);
  }, []);

  useEffect(() => {
    load().catch((loadError) =>
      setError(loadError instanceof Error ? loadError.message : "Unable to load the connection."),
    );
  }, [load]);

  const run = useCallback(
    async (work: () => Promise<void>, success: string) => {
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        await work();
        await load();
        setMessage(success);
      } catch (runError) {
        setError(runError instanceof Error ? runError.message : "Unable to complete request.");
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const connect = () =>
    run(async () => {
      const response = await fetch("/api/workspace/connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shopDomain, accessToken }),
      });
      if (!response.ok) throw await responseError(response);
      setAccessToken("");
    }, "已連線 Connected");

  const rotate = () =>
    run(async () => {
      const response = await fetch("/api/workspace/connection", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accessToken }),
      });
      if (!response.ok) throw await responseError(response);
      setAccessToken("");
      setRotating(false);
    }, "存取權杖已更新 Token rotated");

  return (
    <section className="connection-panel" aria-busy={busy}>
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

      {!loaded ? null : connection ? (
        <div className="connection-summary">
          <p>
            商店網域 Shop domain: <strong>{connection.shopDomain}</strong>
          </p>
          <p>連線起始 Connected since: {new Date(connection.connectedAt).toLocaleDateString()}</p>
          {rotating ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                rotate();
              }}
            >
              <input
                type="password"
                required
                placeholder="new access token"
                aria-label="新的存取權杖 New access token"
                value={accessToken}
                disabled={busy}
                onChange={(event) => setAccessToken(event.target.value)}
              />
              <button type="submit" className="primary-button" disabled={busy || !accessToken}>
                更新權杖 Rotate token
              </button>
            </form>
          ) : (
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={() => setRotating(true)}
            >
              更新權杖 Rotate token
            </button>
          )}
        </div>
      ) : (
        <form
          className="connection-form"
          onSubmit={(event) => {
            event.preventDefault();
            connect();
          }}
        >
          <input
            type="text"
            required
            placeholder="shop.myshopline.com"
            aria-label="SHOPLINE 商店網域 SHOPLINE shop domain"
            value={shopDomain}
            disabled={busy}
            onChange={(event) => setShopDomain(event.target.value)}
          />
          <input
            type="password"
            required
            placeholder="access token"
            aria-label="SHOPLINE 存取權杖 SHOPLINE access token"
            value={accessToken}
            disabled={busy}
            onChange={(event) => setAccessToken(event.target.value)}
          />
          <button
            type="submit"
            className="primary-button"
            disabled={busy || !shopDomain || !accessToken}
          >
            連線 Connect
          </button>
        </form>
      )}
    </section>
  );
}
