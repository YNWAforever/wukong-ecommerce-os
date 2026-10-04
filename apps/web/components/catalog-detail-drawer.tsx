"use client";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { useLocale } from "../lib/locale-context";
import { localized } from "../lib/ui-copy";
import styles from "./catalog-control-center.module.css";
export function CatalogDetailDrawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose(): void;
  children: ReactNode;
}) {
  const locale = useLocale(),
    titleId = useId(),
    ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const trigger =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
    dialog.querySelector<HTMLButtonElement>("button")?.focus();
    function keys(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
      if (event.key !== "Tab" || !dialog) return;
      const focusable = [
        ...dialog.querySelectorAll<HTMLElement>(
          'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
        ),
      ];
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    }
    dialog.addEventListener("keydown", keys);
    return () => {
      dialog.removeEventListener("keydown", keys);
      dialog.close?.();
      document.body.style.overflow = overflow;
      trigger?.focus();
    };
  }, [onClose]);
  return (
    <dialog
      ref={ref}
      className={styles.detailDrawer}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      <div className={styles.detailHeading}>
        <h2 id={titleId}>{title}</h2>
        <button type="button" onClick={onClose}>
          {localized(locale, "關閉資料", "Close details")}
        </button>
      </div>
      <div className={styles.detailBody}>{children}</div>
    </dialog>
  );
}
