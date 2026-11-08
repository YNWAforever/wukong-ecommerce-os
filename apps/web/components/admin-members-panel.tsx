"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useAdminDirtyGuard } from "../lib/admin-dirty-context";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import { roleLabel } from "../lib/role-labels";
import { StatusPill } from "./status-pill";

type Member = {
  userId: string;
  email: string;
  role: string;
  createdAt: string;
};
type Invite = { id: string; email: string; role: string; createdAt: string };
type AssignableRole = "viewer" | "operator" | "reviewer" | "admin";

const ROLE_OPTIONS: AssignableRole[] = [
  "viewer",
  "operator",
  "reviewer",
  "admin",
];

async function responseError(response: Response): Promise<Error> {
  const fallback = `Request failed (${response.status})`;
  try {
    const body = (await response.json()) as { message?: string };
    return new Error(body.message || fallback);
  } catch {
    return new Error(fallback);
  }
}

export function AdminMembersPanel() {
  const locale = useLocale();
  const t = (zh: string, en: string) => localized(locale, zh, en);
  const roleName = (role: string) => roleLabel(role, locale);
  const submitting = useRef(false);
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<AssignableRole>("viewer");

  const load = useCallback(async () => {
    const response = await fetch("/api/workspace/members");
    if (!response.ok) throw await responseError(response);
    const body = (await response.json()) as {
      members: Member[];
      invites: Invite[];
    };
    setMembers(body.members);
    setInvites(body.invites);
  }, []);

  useEffect(() => {
    load().catch((loadError) =>
      setError(
        loadError instanceof Error
          ? loadError.message
          : t("未能載入成員。", "Unable to load members."),
      ),
    );
  }, [load]);

  const run = useCallback(
    // `work` may return a warning: the action committed, but part of it did
    // not, so the outcome is neither a success nor a failure to retry blindly.
    async (work: () => Promise<string | void>, success: string) => {
      if (submitting.current) return false;
      submitting.current = true;
      setBusy(true);
      setError(null);
      setMessage(null);
      try {
        const warning = await work();
        await load();
        if (warning) setError(warning);
        else setMessage(success);
        return true;
      } catch (runError) {
        setError(
          runError instanceof Error
            ? runError.message
            : t("未能完成要求。", "Unable to complete request."),
        );
        return false;
      } finally {
        submitting.current = false;
        setBusy(false);
      }
    },
    [load],
  );

  const invite = async () => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inviteEmail.trim())) {
      setError(t("請填寫有效電郵。", "Enter a valid email address."));
      return false;
    }
    return run(
      async () => {
        const response = await fetch("/api/workspace/members/invite", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email: inviteEmail, role: inviteRole }),
        });
        if (!response.ok) throw await responseError(response);
        setInviteEmail("");
        setInviteRole("viewer");
        const body = (await response.json().catch(() => null)) as {
          emailDelivery?: string;
        } | null;
        // "requested" cannot confirm delivery: the auth flow answers every
        // request the same way so it never reveals whether an address is
        // eligible. Send failures and throttling show only in the auth audit.
        if (body?.emailDelivery === "failed")
          return t(
            "邀請已建立，但未能要求寄出電郵；請檢查電郵設定後再次邀請。",
            "The invite was saved, but its email could not be requested. Check the auth email settings, then invite the same address again.",
          );
      },
      t("邀請已建立，已要求寄出電郵", "Invite saved; email requested"),
    );
  };
  useAdminDirtyGuard("members-invite", {
    dirty: Boolean(inviteEmail || inviteRole !== "viewer" || busy),
    save: invite,
    discard: () => {
      setInviteEmail("");
      setInviteRole("viewer");
      setError(null);
    },
  });

  const changeRole = (userId: string, role: AssignableRole) =>
    run(
      async () => {
        const response = await fetch(`/api/workspace/members/${userId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role }),
        });
        if (!response.ok) throw await responseError(response);
      },
      t("角色已更新", "Role updated"),
    );

  const removeMember = (userId: string) =>
    run(
      async () => {
        const response = await fetch(`/api/workspace/members/${userId}`, {
          method: "DELETE",
        });
        if (!response.ok) throw await responseError(response);
      },
      t("成員已移除", "Member removed"),
    );

  const revokeInvite = (inviteId: string) =>
    run(
      async () => {
        const response = await fetch(`/api/workspace/invites/${inviteId}`, {
          method: "DELETE",
        });
        if (!response.ok) throw await responseError(response);
      },
      t("邀請已撤銷", "Invite revoked"),
    );

  return (
    <section className="members-panel" aria-busy={busy}>
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

      <table className="members-table">
        <thead>
          <tr>
            <th scope="col">{t("電郵", "Email")}</th>
            <th scope="col">{t("角色", "Role")}</th>
            <th scope="col">{t("狀態", "Status")}</th>
            <th scope="col">
              <span className="visually-hidden">{t("操作", "Actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => (
            <tr key={member.userId}>
              <td>{member.email}</td>
              <td>
                {member.role === "owner" ? (
                  roleName(member.role)
                ) : (
                  <select
                    value={member.role}
                    disabled={busy}
                    aria-label={t(
                      `變更 ${member.email} 的角色`,
                      `Change role for ${member.email}`,
                    )}
                    onChange={(event) =>
                      changeRole(
                        member.userId,
                        event.target.value as AssignableRole,
                      )
                    }
                  >
                    {ROLE_OPTIONS.map((role) => (
                      <option key={role} value={role}>
                        {roleName(role)}
                      </option>
                    ))}
                  </select>
                )}
              </td>
              <td>
                <StatusPill tone="success">{t("啟用中", "Active")}</StatusPill>
              </td>
              <td>
                {member.role === "owner" ? null : (
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={busy}
                    onClick={() => removeMember(member.userId)}
                  >
                    {t("移除", "Remove")}
                  </button>
                )}
              </td>
            </tr>
          ))}
          {invites.map((pendingInvite) => (
            <tr key={pendingInvite.id}>
              <td>{pendingInvite.email}</td>
              <td>{roleName(pendingInvite.role)}</td>
              <td>
                <StatusPill tone="warning">{t("待接受", "Pending")}</StatusPill>
              </td>
              <td>
                <button
                  type="button"
                  className="secondary-button"
                  disabled={busy}
                  onClick={() => revokeInvite(pendingInvite.id)}
                >
                  {t("撤銷", "Revoke")}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <form
        className="invite-form"
        onSubmit={(event) => {
          event.preventDefault();
          invite();
        }}
      >
        <input
          type="email"
          required
          placeholder="email@example.com"
          aria-label={t("邀請成員的電子郵件", "Invite email address")}
          value={inviteEmail}
          disabled={busy}
          onChange={(event) => setInviteEmail(event.target.value)}
        />
        <select
          value={inviteRole}
          disabled={busy}
          aria-label={t("新成員的角色", "Role for new member")}
          onChange={(event) =>
            setInviteRole(event.target.value as AssignableRole)
          }
        >
          {ROLE_OPTIONS.map((role) => (
            <option key={role} value={role}>
              {roleName(role)}
            </option>
          ))}
        </select>
        <button
          type="submit"
          className="primary-button"
          disabled={busy || !inviteEmail}
        >
          {t("邀請成員", "Invite member")}
        </button>
      </form>
    </section>
  );
}
