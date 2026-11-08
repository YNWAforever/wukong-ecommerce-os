"use client";

import { useState, type FormEvent } from "react";

import type { Locale } from "../lib/locale";
import type {
  CreateMcpTokenResult,
  McpTokenView,
} from "../lib/studio/mcp-tokens";
import {
  studioSettingsCopy,
  type StudioSettingsCopyKey,
} from "../lib/studio-settings-copy";
import { formatHkDate } from "../lib/ui-copy";
import styles from "./studio.module.css";

/**
 * Admin API-token panel (plan Task 12/13 settings surface).
 *
 * The plaintext token is rendered only from the create response and only once;
 * the list never contains a token value. Every action shows an honest localized
 * failure instead of a raw response.
 */

export type StudioTokenPanelProps = {
  locale: Locale;
  initialTokens: readonly McpTokenView[];
};

const SCOPE_KEYS: ReadonlyArray<{
  scope: "read" | "propose";
  copyKey: StudioSettingsCopyKey;
}> = [
  { scope: "read", copyKey: "studio.settings.tokens.scope.read" },
  { scope: "propose", copyKey: "studio.settings.tokens.scope.propose" },
];

export function StudioTokenPanel({
  locale,
  initialTokens,
}: StudioTokenPanelProps) {
  const copy = (key: StudioSettingsCopyKey) => studioSettingsCopy(locale, key);
  const [tokens, setTokens] = useState<McpTokenView[]>([...initialTokens]);
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<Record<"read" | "propose", boolean>>({
    read: true,
    propose: false,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<StudioSettingsCopyKey | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function createToken(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = label.trim();
    if (trimmed.length === 0) {
      setError("studio.settings.tokens.labelRequired");
      return;
    }
    const selected = SCOPE_KEYS.map((entry) => entry.scope).filter(
      (scope) => scopes[scope],
    );
    if (selected.length === 0) return;
    setBusy("create");
    setError(null);
    setCopied(false);
    try {
      const response = await fetch("/api/studio/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ label: trimmed, scopes: selected }),
      });
      if (!response.ok) throw new Error("create failed");
      const created = (await response.json()) as CreateMcpTokenResult;
      const { token, ...view } = created;
      setTokens((current) => [view, ...current]);
      setRevealed(token);
      setLabel("");
    } catch {
      setError("studio.settings.tokens.actionError");
    } finally {
      setBusy(null);
    }
  }

  async function revokeToken(tokenId: string) {
    setBusy(tokenId);
    setError(null);
    try {
      const response = await fetch(`/api/studio/tokens/${tokenId}`, {
        method: "DELETE",
      });
      if (!response.ok) throw new Error("revoke failed");
      const revoked = (await response.json()) as { revokedAt: string };
      setTokens((current) =>
        current.map((token) =>
          token.tokenId === tokenId
            ? { ...token, revokedAt: revoked.revokedAt }
            : token,
        ),
      );
    } catch {
      setError("studio.settings.tokens.actionError");
    } finally {
      setBusy(null);
    }
  }

  async function copyRevealed() {
    if (!revealed) return;
    try {
      await navigator.clipboard?.writeText(revealed);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  return (
    <section
      className={styles["studio-section"]}
      aria-labelledby="studio-settings-tokens"
    >
      <header className={styles["studio-section-header"]}>
        <h2
          id="studio-settings-tokens"
          className={styles["studio-section-title"]}
        >
          {copy("studio.settings.tokens.title")}
        </h2>
        <p className={styles["studio-section-lede"]}>
          {copy("studio.settings.tokens.lede")}
        </p>
      </header>

      <form
        className={styles["studio-connection-card"]}
        onSubmit={(event) => void createToken(event)}
      >
        <label>
          {copy("studio.settings.tokens.label")}
          <input
            className={styles["studio-composer-textarea"]}
            name="token-label"
            value={label}
            maxLength={100}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <fieldset>
          <legend>{copy("studio.settings.tokens.scopes")}</legend>
          {SCOPE_KEYS.map((entry) => (
            <label key={entry.scope}>
              <input
                type="checkbox"
                checked={scopes[entry.scope]}
                onChange={(event) =>
                  setScopes((current) => ({
                    ...current,
                    [entry.scope]: event.target.checked,
                  }))
                }
              />{" "}
              {copy(entry.copyKey)}
            </label>
          ))}
        </fieldset>
        <button
          type="submit"
          className={styles["studio-secondary-button"]}
          disabled={busy !== null}
        >
          {busy === "create"
            ? copy("studio.settings.tokens.creating")
            : copy("studio.settings.tokens.create")}
        </button>
        {error ? (
          <p role="alert" className={styles["studio-composer-error"]}>
            {copy(error)}
          </p>
        ) : null}
      </form>

      {revealed ? (
        <div className={styles["studio-notice"]} role="status">
          <p>{copy("studio.settings.tokens.plaintextOnce")}</p>
          <p>
            <code>{revealed}</code>{" "}
            <button
              type="button"
              className={styles["studio-secondary-button"]}
              onClick={() => void copyRevealed()}
            >
              {copied
                ? copy("studio.settings.tokens.copied")
                : copy("studio.settings.tokens.copy")}
            </button>
          </p>
        </div>
      ) : null}

      {tokens.length === 0 ? (
        <p className={styles["studio-empty"]}>
          {copy("studio.settings.tokens.empty")}
        </p>
      ) : (
        <div className={styles["studio-table-scroll"]}>
          <table className={styles["studio-tools-table"]}>
            <thead>
              <tr>
                <th scope="col">{copy("studio.settings.tokens.label")}</th>
                <th scope="col">{copy("studio.settings.tokens.prefix")}</th>
                <th scope="col">{copy("studio.settings.tokens.scopes")}</th>
                <th scope="col">{copy("studio.settings.tokens.created")}</th>
                <th scope="col">{copy("studio.settings.tokens.lastUsed")}</th>
                <th scope="col">{copy("studio.settings.tokens.active")}</th>
                <th scope="col" aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => {
                const revoked = token.revokedAt !== null;
                return (
                  <tr key={token.tokenId}>
                    <td>{token.label}</td>
                    <td>
                      <code>{token.prefix}</code>
                    </td>
                    <td>
                      {token.scopes
                        .map((scope) =>
                          copy(
                            scope === "propose"
                              ? "studio.settings.tokens.scope.propose"
                              : "studio.settings.tokens.scope.read",
                          ),
                        )
                        .join(", ")}
                    </td>
                    <td>{formatHkDate(token.createdAt, locale)}</td>
                    <td>
                      {token.lastUsedAt
                        ? formatHkDate(token.lastUsedAt, locale)
                        : copy("studio.settings.tokens.neverUsed")}
                    </td>
                    <td>
                      {revoked
                        ? copy("studio.settings.tokens.revoked")
                        : copy("studio.settings.tokens.active")}
                    </td>
                    <td>
                      {revoked ? null : (
                        <button
                          type="button"
                          className={styles["studio-secondary-button"]}
                          disabled={busy !== null}
                          onClick={() => void revokeToken(token.tokenId)}
                        >
                          {busy === token.tokenId
                            ? copy("studio.settings.tokens.revoking")
                            : copy("studio.settings.tokens.revoke")}
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
