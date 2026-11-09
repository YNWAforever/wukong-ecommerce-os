"use client";

import { useState, type FormEvent } from "react";

import type { Locale } from "../lib/locale";
import type {
  CreateMcpTokenResult,
  McpTokenView,
  McpTokenUsage,
} from "../lib/studio/mcp-tokens";
import {
  studioSettingsCopy,
  type StudioSettingsCopyKey,
} from "../lib/studio-settings-copy";
import { formatHkDate } from "../lib/ui-copy";
import styles from "./studio.module.css";

/**
 * Admin API-token panel (plan Task 12/13 settings surface; B4 quotas + rotation).
 *
 * The plaintext token is rendered only from a create/rotate response and only
 * once; the list never contains a token value. Every action shows an honest
 * localized failure instead of a raw response. Quotas are nullable: an empty
 * input means unlimited, matching the API and the database CHECK constraints.
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

function parseLimit(
  value: string,
  min: number,
  max: number,
): number | null | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max)
    return undefined;
  return parsed;
}

function formatQuota(
  limit: number | null,
  unit: StudioSettingsCopyKey,
  copy: (key: StudioSettingsCopyKey) => string,
): string {
  return limit === null
    ? copy("studio.settings.tokens.quotaUnlimited")
    : `${limit} / ${copy(unit)}`;
}

function formatUsage(
  usage: McpTokenUsage,
  copy: (key: StudioSettingsCopyKey) => string,
): string {
  return `${usage.minuteCalls} ${copy("studio.settings.tokens.usageMinute")} · ${usage.monthCalls} ${copy("studio.settings.tokens.usageMonth")}`;
}

type EditState = {
  tokenId: string;
  rate: string;
  monthly: string;
};

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
  const [rateInput, setRateInput] = useState("");
  const [monthlyInput, setMonthlyInput] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<StudioSettingsCopyKey | null>(null);
  const [notice, setNotice] = useState<StudioSettingsCopyKey | null>(null);
  const [revealed, setRevealed] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /** Token whose quota edit form is open. */
  const [editing, setEditing] = useState<EditState | null>(null);
  /** Token awaiting rotation confirmation (the plaintext is shown once). */
  const [rotatingConfirm, setRotatingConfirm] = useState<string | null>(null);
  const [rotating, setRotating] = useState<string | null>(null);

  function replaceToken(tokenId: string, replacement: McpTokenView) {
    setTokens((current) =>
      current.map((token) => (token.tokenId === tokenId ? replacement : token)),
    );
  }

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
    const rateLimitPerMinute = parseLimit(rateInput, 1, 600);
    const monthlyCallQuota = parseLimit(monthlyInput, 1, 1_000_000);
    if (rateLimitPerMinute === undefined || monthlyCallQuota === undefined) {
      setError("studio.settings.tokens.quotaInvalid");
      return;
    }
    setBusy("create");
    setError(null);
    setNotice(null);
    setCopied(false);
    try {
      const response = await fetch("/api/studio/tokens", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: trimmed,
          scopes: selected,
          ...(rateLimitPerMinute === null ? {} : { rateLimitPerMinute }),
          ...(monthlyCallQuota === null ? {} : { monthlyCallQuota }),
        }),
      });
      if (!response.ok) throw new Error("create failed");
      const created = (await response.json()) as CreateMcpTokenResult;
      const { token, ...view } = created;
      setTokens((current) => [view, ...current]);
      setRevealed(token);
      setLabel("");
      setRateInput("");
      setMonthlyInput("");
    } catch {
      setError("studio.settings.tokens.actionError");
    } finally {
      setBusy(null);
    }
  }

  async function revokeToken(tokenId: string) {
    setBusy(tokenId);
    setError(null);
    setNotice(null);
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
      setError("studio.settings.tokens.revokeError");
    } finally {
      setBusy(null);
    }
  }

  async function saveLimits(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!editing) return;
    const rate = parseLimit(editing.rate, 1, 600);
    const monthly = parseLimit(editing.monthly, 1, 1_000_000);
    if (rate === undefined || monthly === undefined) {
      setError("studio.settings.tokens.quotaInvalid");
      return;
    }
    setBusy(`limits:${editing.tokenId}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(`/api/studio/tokens/${editing.tokenId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          rateLimitPerMinute: rate,
          monthlyCallQuota: monthly,
        }),
      });
      if (!response.ok) throw new Error("limits failed");
      const updated = (await response.json()) as McpTokenView;
      replaceToken(editing.tokenId, updated);
      setEditing(null);
      setNotice("studio.settings.tokens.limitsSaved");
    } catch {
      setError("studio.settings.tokens.limitsError");
    } finally {
      setBusy(null);
    }
  }

  async function rotateToken(tokenId: string) {
    setBusy(`rotate:${tokenId}`);
    setError(null);
    setNotice(null);
    setCopied(false);
    try {
      const response = await fetch(`/api/studio/tokens/${tokenId}/rotate`, {
        method: "POST",
      });
      if (!response.ok) throw new Error("rotate failed");
      const rotated = (await response.json()) as CreateMcpTokenResult;
      const { token, ...view } = rotated;
      replaceToken(tokenId, view);
      setRevealed(token);
      setRotatingConfirm(null);
    } catch {
      setError("studio.settings.tokens.rotateError");
    } finally {
      setRotating(null);
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
        <div className={styles["studio-token-quota-fields"]}>
          <label>
            {copy("studio.settings.tokens.quotaRate")}
            <input
              className={styles["studio-composer-textarea"]}
              name="token-rate-limit"
              inputMode="numeric"
              value={rateInput}
              maxLength={3}
              placeholder={copy("studio.settings.tokens.quotaUnlimited")}
              onChange={(event) => setRateInput(event.target.value)}
            />
          </label>
          <label>
            {copy("studio.settings.tokens.quotaMonthly")}
            <input
              className={styles["studio-composer-textarea"]}
              name="token-monthly-quota"
              inputMode="numeric"
              value={monthlyInput}
              maxLength={7}
              placeholder={copy("studio.settings.tokens.quotaUnlimited")}
              onChange={(event) => setMonthlyInput(event.target.value)}
            />
          </label>
        </div>
        <p className={styles["studio-evidence-note"]}>
          {copy("studio.settings.tokens.quotaHint")}
        </p>
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
        {notice ? (
          <p role="status" className={styles["studio-output-notice"]}>
            {copy(notice)}
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
                <th scope="col">{copy("studio.settings.tokens.quotas")}</th>
                <th scope="col">{copy("studio.settings.tokens.usage")}</th>
                <th scope="col">{copy("studio.settings.tokens.created")}</th>
                <th scope="col">{copy("studio.settings.tokens.lastUsed")}</th>
                <th scope="col">{copy("studio.settings.tokens.active")}</th>
                <th scope="col" aria-label="actions" />
              </tr>
            </thead>
            <tbody>
              {tokens.map((token) => {
                const revoked = token.revokedAt !== null;
                const editingThis = editing?.tokenId === token.tokenId;
                const limitsBusy = busy === `limits:${token.tokenId}`;
                const rotateBusy = busy === `rotate:${token.tokenId}`;
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
                    <td>
                      {editingThis ? (
                        <form
                          className={styles["studio-token-edit-form"]}
                          onSubmit={(event) => void saveLimits(event)}
                        >
                          <label>
                            {copy("studio.settings.tokens.quotaRate")}
                            <input
                              name="edit-rate-limit"
                              inputMode="numeric"
                              maxLength={3}
                              value={editing.rate}
                              onChange={(event) =>
                                setEditing({
                                  ...editing,
                                  rate: event.target.value,
                                })
                              }
                            />
                          </label>
                          <label>
                            {copy("studio.settings.tokens.quotaMonthly")}
                            <input
                              name="edit-monthly-quota"
                              inputMode="numeric"
                              maxLength={7}
                              value={editing.monthly}
                              onChange={(event) =>
                                setEditing({
                                  ...editing,
                                  monthly: event.target.value,
                                })
                              }
                            />
                          </label>
                          <div className={styles["studio-token-actions"]}>
                            <button
                              type="submit"
                              className={styles["studio-secondary-button"]}
                              disabled={busy !== null}
                            >
                              {limitsBusy
                                ? copy("studio.settings.tokens.savingLimits")
                                : copy("studio.settings.tokens.saveLimits")}
                            </button>
                            <button
                              type="button"
                              className={styles["studio-secondary-button"]}
                              disabled={busy !== null}
                              onClick={() => setEditing(null)}
                            >
                              {copy("studio.settings.tokens.cancel")}
                            </button>
                          </div>
                        </form>
                      ) : (
                        <span className={styles["studio-token-quotas"]}>
                          {formatQuota(
                            token.rateLimitPerMinute,
                            "studio.settings.tokens.usageMinute",
                            copy,
                          )}
                          {" · "}
                          {formatQuota(
                            token.monthlyCallQuota,
                            "studio.settings.tokens.usageMonth",
                            copy,
                          )}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className={styles["studio-token-usage"]}>
                        {formatUsage(token.usage, copy)}
                      </span>
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
                        <div className={styles["studio-token-actions"]}>
                          {editingThis ? null : (
                            <button
                              type="button"
                              className={styles["studio-secondary-button"]}
                              disabled={busy !== null}
                              onClick={() =>
                                setEditing({
                                  tokenId: token.tokenId,
                                  rate:
                                    token.rateLimitPerMinute === null
                                      ? ""
                                      : String(token.rateLimitPerMinute),
                                  monthly:
                                    token.monthlyCallQuota === null
                                      ? ""
                                      : String(token.monthlyCallQuota),
                                })
                              }
                            >
                              {copy("studio.settings.tokens.editLimits")}
                            </button>
                          )}
                          {rotatingConfirm === token.tokenId ? (
                            <>
                              <p
                                className={styles["studio-evidence-note"]}
                                role="alert"
                              >
                                {copy("studio.settings.tokens.rotateConfirm")}
                              </p>
                              <button
                                type="button"
                                className={styles["studio-secondary-button"]}
                                disabled={busy !== null}
                                onClick={() => {
                                  setRotating(token.tokenId);
                                  void rotateToken(token.tokenId);
                                }}
                              >
                                {rotating === token.tokenId
                                  ? copy("studio.settings.tokens.rotating")
                                  : copy(
                                      "studio.settings.tokens.rotateConfirmAction",
                                    )}
                              </button>
                              <button
                                type="button"
                                className={styles["studio-secondary-button"]}
                                disabled={busy !== null}
                                onClick={() => setRotatingConfirm(null)}
                              >
                                {copy("studio.settings.tokens.cancel")}
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              className={styles["studio-secondary-button"]}
                              disabled={busy !== null}
                              onClick={() => setRotatingConfirm(token.tokenId)}
                            >
                              {rotateBusy
                                ? copy("studio.settings.tokens.rotating")
                                : copy("studio.settings.tokens.rotate")}
                            </button>
                          )}
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
                        </div>
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
