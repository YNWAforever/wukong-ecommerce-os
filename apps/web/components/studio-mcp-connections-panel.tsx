"use client";

import { useState, type FormEvent } from "react";

import type { Locale } from "../lib/locale";
import type {
  McpConnectionView,
  McpConnectionsSnapshot,
  McpProbeResult,
} from "../lib/studio/mcp-connections";
import {
  studioSettingsCopy,
  type StudioSettingsCopyKey,
} from "../lib/studio-settings-copy";
import { formatHkDate } from "../lib/ui-copy";
import styles from "./studio.module.css";

/**
 * Admin external-MCP registry panel (plan Task 13).
 *
 * External connections are disabled by default. The panel records a draft,
 * binds the encrypted workspace credential, and offers an explicit admin probe
 * (`initialize` + `tools/list` only) so advertised schema hashes can be pinned
 * before approval; those are the only network actions here and they are
 * disabled until the flag, workspace row and encryption key are all in place.
 * Approval and disable are separate explicit admin actions. There is no
 * "connected" indicator because no skill call site consumes a connection.
 */

export type StudioMcpConnectionsPanelProps = {
  locale: Locale;
  snapshot: McpConnectionsSnapshot;
};

const STATUS_COPY: Record<McpConnectionView["status"], StudioSettingsCopyKey> =
  {
    draft: "studio.settings.external.status.draft",
    approved: "studio.settings.external.status.approved",
    disabled: "studio.settings.external.status.disabled",
  };

const PROBE_STATUS_COPY: Record<
  McpProbeResult["status"],
  StudioSettingsCopyKey
> = {
  ok: "studio.settings.external.probeStatus.ok",
  schema_drift: "studio.settings.external.probeStatus.schema_drift",
  denied: "studio.settings.external.probeStatus.denied",
  unavailable: "studio.settings.external.probeStatus.unavailable",
  timeout: "studio.settings.external.probeStatus.timeout",
};

function parseAllowlist(value: string): string[] {
  return [
    ...new Set(
      value
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    ),
  ];
}

function parseSchemaHashes(
  value: string,
  allowlist: readonly string[],
): Record<string, string> | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return null;
    const hashes: Record<string, string> = {};
    for (const [tool, hash] of Object.entries(parsed)) {
      if (!allowlist.includes(tool)) return null;
      if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) return null;
      hashes[tool] = hash;
    }
    return hashes;
  } catch {
    return null;
  }
}

export function StudioMcpConnectionsPanel({
  locale,
  snapshot,
}: StudioMcpConnectionsPanelProps) {
  const copy = (key: StudioSettingsCopyKey) => studioSettingsCopy(locale, key);
  const [items, setItems] = useState<McpConnectionView[]>([...snapshot.items]);
  const [label, setLabel] = useState("");
  const [endpointUrl, setEndpointUrl] = useState("");
  const [transport, setTransport] = useState<"http" | "sse">("http");
  const [allowlist, setAllowlist] = useState("");
  const [schemaHashes, setSchemaHashes] = useState("");
  const [credentialDrafts, setCredentialDrafts] = useState<
    Record<string, string>
  >({});
  const [probeResults, setProbeResults] = useState<
    Record<string, McpProbeResult>
  >({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<StudioSettingsCopyKey | null>(null);
  const [notice, setNotice] = useState<StudioSettingsCopyKey | null>(null);

  const approvable = snapshot.approvable;
  const probeAvailable = snapshot.probeAvailable;

  async function createConnection(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (label.trim().length === 0) {
      setError("studio.settings.external.labelRequired");
      return;
    }
    const tools = parseAllowlist(allowlist);
    if (tools.length === 0) {
      setError("studio.settings.external.allowlistRequired");
      return;
    }
    const hashes = parseSchemaHashes(schemaHashes, tools);
    if (!hashes) {
      setError("studio.settings.external.schemaHashesInvalid");
      return;
    }
    setBusy("create");
    setError(null);
    setNotice(null);
    try {
      const response = await fetch("/api/studio/mcp-connections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          label: label.trim(),
          endpointUrl: endpointUrl.trim(),
          transport,
          toolAllowlist: tools,
          schemaHashes: hashes,
        }),
      });
      if (!response.ok) {
        setError(
          response.status === 400
            ? "studio.settings.external.invalidEndpoint"
            : "studio.settings.external.actionError",
        );
        return;
      }
      const created = (await response.json()) as McpConnectionView;
      setItems((current) => [created, ...current]);
      setLabel("");
      setEndpointUrl("");
      setAllowlist("");
      setSchemaHashes("");
      setNotice("studio.settings.external.created");
    } catch {
      setError("studio.settings.external.actionError");
    } finally {
      setBusy(null);
    }
  }

  async function changeStatus(
    connectionId: string,
    status: "approved" | "disabled",
  ) {
    setBusy(connectionId);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/studio/mcp-connections/${connectionId}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status }),
        },
      );
      if (!response.ok) {
        // Never claim a gate that is not actually open.
        if (!snapshot.externalFlagOn) {
          setError("studio.settings.external.flagOff");
        } else if (!snapshot.encryptionKeyPresent) {
          setError("studio.settings.external.keyMissing");
        } else {
          setError(
            response.status === 400
              ? "studio.settings.external.approveBlocked"
              : "studio.settings.external.actionError",
          );
        }
        return;
      }
      const updated = (await response.json()) as McpConnectionView;
      setItems((current) =>
        current.map((item) =>
          item.connectionId === connectionId ? updated : item,
        ),
      );
      setNotice(
        status === "approved"
          ? "studio.settings.external.approved"
          : "studio.settings.external.disabledDone",
      );
    } catch {
      setError("studio.settings.external.actionError");
    } finally {
      setBusy(null);
    }
  }

  function replaceItem(updated: McpConnectionView) {
    setItems((current) =>
      current.map((item) =>
        item.connectionId === updated.connectionId ? updated : item,
      ),
    );
  }

  async function saveCredential(connectionId: string) {
    const credential = (credentialDrafts[connectionId] ?? "").trim();
    if (credential.length === 0) {
      setError("studio.settings.external.credentialRequired");
      return;
    }
    setBusy(`credential:${connectionId}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/studio/mcp-connections/${connectionId}/credential`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ credential }),
        },
      );
      if (!response.ok) {
        setError(
          response.status === 409
            ? "studio.settings.external.probeBlocked"
            : "studio.settings.external.actionError",
        );
        return;
      }
      replaceItem((await response.json()) as McpConnectionView);
      setCredentialDrafts((current) => ({ ...current, [connectionId]: "" }));
      setProbeResults((current) => {
        const next = { ...current };
        delete next[connectionId];
        return next;
      });
      setNotice("studio.settings.external.credentialSaved");
    } catch {
      setError("studio.settings.external.actionError");
    } finally {
      setBusy(null);
    }
  }

  async function clearCredential(connectionId: string) {
    setBusy(`clear:${connectionId}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/studio/mcp-connections/${connectionId}/credential`,
        { method: "DELETE" },
      );
      if (!response.ok) {
        setError("studio.settings.external.actionError");
        return;
      }
      replaceItem((await response.json()) as McpConnectionView);
      setNotice("studio.settings.external.credentialCleared");
    } catch {
      setError("studio.settings.external.actionError");
    } finally {
      setBusy(null);
    }
  }

  async function probeConnection(connectionId: string) {
    setBusy(`probe:${connectionId}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/studio/mcp-connections/${connectionId}/probe`,
        { method: "POST" },
      );
      if (!response.ok) {
        setError(
          response.status === 409
            ? "studio.settings.external.probeBlocked"
            : "studio.settings.external.probeError",
        );
        return;
      }
      const result = (await response.json()) as McpProbeResult;
      setProbeResults((current) => ({ ...current, [connectionId]: result }));
    } catch {
      setError("studio.settings.external.probeError");
    } finally {
      setBusy(null);
    }
  }

  async function pinAdvertisedHashes(connectionId: string) {
    const result = probeResults[connectionId];
    if (!result) return;
    const hashes: Record<string, string> = {};
    for (const tool of result.tools) {
      if (tool.allowlisted) hashes[tool.name] = tool.advertisedHash;
    }
    if (Object.keys(hashes).length === 0) return;
    setBusy(`pin:${connectionId}`);
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/studio/mcp-connections/${connectionId}/schemas`,
        {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ schemaHashes: hashes }),
        },
      );
      if (!response.ok) {
        setError("studio.settings.external.actionError");
        return;
      }
      replaceItem((await response.json()) as McpConnectionView);
      setNotice("studio.settings.external.pinnedDone");
    } catch {
      setError("studio.settings.external.actionError");
    } finally {
      setBusy(null);
    }
  }

  return (
    <section
      className={styles["studio-section"]}
      aria-labelledby="studio-settings-external"
    >
      <header className={styles["studio-section-header"]}>
        <h2
          id="studio-settings-external"
          className={styles["studio-section-title"]}
        >
          {copy("studio.settings.external.title")}
        </h2>
        <p className={styles["studio-section-lede"]}>
          {copy("studio.settings.external.lede")}
        </p>
      </header>

      <p className={styles["studio-notice"]} role="note">
        {copy("studio.settings.external.disabledBanner")}
      </p>
      {!snapshot.externalFlagOn ? (
        <p className={styles["studio-notice"]}>
          {copy("studio.settings.external.flagOff")}
        </p>
      ) : null}
      {!snapshot.encryptionKeyPresent ? (
        <p className={styles["studio-notice"]}>
          {copy("studio.settings.external.keyMissing")}
        </p>
      ) : null}
      {!approvable ? (
        <p className={styles["studio-notice"]}>
          {copy("studio.settings.external.approveBlocked")}
        </p>
      ) : null}
      <p className={styles["studio-notice"]}>
        {copy("studio.settings.noLiveConnection")}
      </p>

      <form
        className={styles["studio-connection-card"]}
        onSubmit={(event) => void createConnection(event)}
      >
        <label>
          {copy("studio.settings.external.label")}
          <input
            className={styles["studio-composer-textarea"]}
            name="connection-label"
            value={label}
            maxLength={100}
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <label>
          {copy("studio.settings.external.endpoint")}
          <input
            className={styles["studio-composer-textarea"]}
            name="connection-endpoint"
            value={endpointUrl}
            placeholder="https://"
            onChange={(event) => setEndpointUrl(event.target.value)}
          />
        </label>
        <label>
          {copy("studio.settings.external.transport")}
          <select
            className={styles["studio-composer-textarea"]}
            name="connection-transport"
            value={transport}
            onChange={(event) =>
              setTransport(event.target.value === "sse" ? "sse" : "http")
            }
          >
            <option value="http">http</option>
            <option value="sse">sse</option>
          </select>
        </label>
        <label>
          {copy("studio.settings.external.allowlist")}
          <textarea
            className={styles["studio-composer-textarea"]}
            name="connection-allowlist"
            value={allowlist}
            onChange={(event) => setAllowlist(event.target.value)}
          />
        </label>
        <label>
          {copy("studio.settings.external.schemaHashes")}
          <textarea
            className={styles["studio-composer-textarea"]}
            name="connection-schema-hashes"
            value={schemaHashes}
            onChange={(event) => setSchemaHashes(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className={styles["studio-secondary-button"]}
          disabled={busy !== null}
        >
          {busy === "create"
            ? copy("studio.settings.external.creating")
            : copy("studio.settings.external.create")}
        </button>
        {error ? (
          <p role="alert" className={styles["studio-composer-error"]}>
            {copy(error)}
          </p>
        ) : null}
        {notice ? (
          <p role="status" className={styles["studio-notice"]}>
            {copy(notice)}
          </p>
        ) : null}
      </form>

      {items.length === 0 ? (
        <p className={styles["studio-empty"]}>
          {copy("studio.settings.external.empty")}
        </p>
      ) : (
        <ul className={styles["studio-connection-list"]}>
          {items.map((item) => (
            <li
              key={item.connectionId}
              className={styles["studio-connection-card"]}
            >
              <div className={styles["studio-section-header"]}>
                <h3>{item.label}</h3>
                <span className={styles["studio-badge"]}>
                  {copy(STATUS_COPY[item.status])}
                </span>
              </div>
              <p className={styles["studio-connection-state"]}>
                <code>{item.endpointUrl}</code> · {item.transport} ·{" "}
                {copy("studio.settings.external.generation")} {item.generation}
              </p>
              <p>
                {copy("studio.settings.external.tools")}:{" "}
                {item.toolAllowlist.join(", ")}
              </p>
              <ul>
                {Object.entries(item.schemaHashes).map(([tool, hash]) => (
                  <li key={tool}>
                    <code>{tool}</code>:{" "}
                    <code>{String(hash).slice(0, 16)}…</code>
                  </li>
                ))}
              </ul>
              <label>
                {copy("studio.settings.external.credential")}
                <input
                  className={styles["studio-composer-textarea"]}
                  type="password"
                  name={`connection-credential-${item.connectionId}`}
                  value={credentialDrafts[item.connectionId] ?? ""}
                  placeholder={copy(
                    "studio.settings.external.credentialPlaceholder",
                  )}
                  autoComplete="off"
                  disabled={!probeAvailable || busy !== null}
                  onChange={(event) =>
                    setCredentialDrafts((current) => ({
                      ...current,
                      [item.connectionId]: event.target.value,
                    }))
                  }
                />
              </label>
              <p className={styles["studio-connection-state"]}>
                {item.credentialPresent
                  ? copy("studio.settings.external.credentialPresent")
                  : copy("studio.settings.external.credentialAbsent")}
              </p>
              <div className={styles["studio-composer-actions"]}>
                <button
                  type="button"
                  className={styles["studio-secondary-button"]}
                  disabled={!probeAvailable || busy !== null}
                  title={
                    probeAvailable
                      ? undefined
                      : copy("studio.settings.external.probeBlocked")
                  }
                  onClick={() => void saveCredential(item.connectionId)}
                >
                  {busy === `credential:${item.connectionId}`
                    ? copy("studio.settings.external.savingCredential")
                    : copy("studio.settings.external.saveCredential")}
                </button>
                <button
                  type="button"
                  className={styles["studio-secondary-button"]}
                  disabled={
                    !probeAvailable || !item.credentialPresent || busy !== null
                  }
                  onClick={() => void clearCredential(item.connectionId)}
                >
                  {busy === `clear:${item.connectionId}`
                    ? copy("studio.settings.external.clearingCredential")
                    : copy("studio.settings.external.clearCredential")}
                </button>
                <button
                  type="button"
                  className={styles["studio-secondary-button"]}
                  disabled={
                    !probeAvailable ||
                    item.status === "disabled" ||
                    busy !== null
                  }
                  title={
                    probeAvailable && item.status !== "disabled"
                      ? copy("studio.settings.external.probeHint")
                      : copy("studio.settings.external.probeBlocked")
                  }
                  onClick={() => void probeConnection(item.connectionId)}
                >
                  {busy === `probe:${item.connectionId}`
                    ? copy("studio.settings.external.probing")
                    : copy("studio.settings.external.probe")}
                </button>
              </div>
              {probeResults[item.connectionId] ? (
                <div>
                  <h4>
                    {copy("studio.settings.external.probeTitle")} ·{" "}
                    {copy(
                      PROBE_STATUS_COPY[
                        probeResults[item.connectionId]!.status
                      ],
                    )}
                  </h4>
                  <ul>
                    {probeResults[item.connectionId]!.tools.map((tool) => (
                      <li key={tool.name}>
                        <code>{tool.name}</code>:{" "}
                        {copy("studio.settings.external.probeAdvertised")}{" "}
                        <code>{tool.advertisedHash.slice(0, 16)}…</code> ·{" "}
                        {tool.pinnedHash === null
                          ? copy("studio.settings.external.probeNotPinned")
                          : `${copy("studio.settings.external.probePinned")} `}
                        {tool.pinnedHash === null ? null : (
                          <code>{tool.pinnedHash.slice(0, 16)}…</code>
                        )}
                      </li>
                    ))}
                  </ul>
                  {probeResults[item.connectionId]!.missingAllowlisted.length >
                  0 ? (
                    <p>
                      {copy("studio.settings.external.probeMissingTools")}{" "}
                      {probeResults[item.connectionId]!.missingAllowlisted.join(
                        ", ",
                      )}
                    </p>
                  ) : null}
                  {probeResults[item.connectionId]!.missingPins.length > 0 ||
                  probeResults[item.connectionId]!.drift.length > 0 ? (
                    <button
                      type="button"
                      className={styles["studio-secondary-button"]}
                      disabled={busy !== null}
                      onClick={() =>
                        void pinAdvertisedHashes(item.connectionId)
                      }
                    >
                      {busy === `pin:${item.connectionId}`
                        ? copy("studio.settings.external.pinning")
                        : copy("studio.settings.external.pinAdvertised")}
                    </button>
                  ) : null}
                </div>
              ) : null}
              <p>
                {copy("studio.settings.external.approvedBy")}:{" "}
                {item.approvedBy ?? copy("studio.settings.workspace.notSet")} ·{" "}
                {item.approvedAt
                  ? formatHkDate(item.approvedAt, locale)
                  : copy("studio.settings.workspace.notSet")}
              </p>
              <div className={styles["studio-composer-actions"]}>
                {item.status !== "approved" ? (
                  <button
                    type="button"
                    className={styles["studio-secondary-button"]}
                    disabled={!approvable || busy !== null}
                    title={
                      approvable
                        ? undefined
                        : copy("studio.settings.external.approveBlocked")
                    }
                    onClick={() =>
                      void changeStatus(item.connectionId, "approved")
                    }
                  >
                    {busy === item.connectionId
                      ? copy("studio.settings.external.approving")
                      : copy("studio.settings.external.approve")}
                  </button>
                ) : (
                  <button
                    type="button"
                    className={styles["studio-secondary-button"]}
                    disabled={busy !== null}
                    onClick={() =>
                      void changeStatus(item.connectionId, "disabled")
                    }
                  >
                    {busy === item.connectionId
                      ? copy("studio.settings.external.disabling")
                      : copy("studio.settings.external.disable")}
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
