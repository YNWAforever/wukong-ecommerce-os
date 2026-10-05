"use client";
import { useEffect } from "react";
const EVENT = "wukong-workspace-settings-saved";
export function publishSettingsFence(previousDigest: string, digest: string) {
  window.dispatchEvent(
    new CustomEvent(EVENT, { detail: { previousDigest, digest } }),
  );
}
export function useSettingsFence(
  update: (previous: string, next: string) => void,
) {
  useEffect(() => {
    const listener = (event: Event) => {
      const { previousDigest, digest } = (
        event as CustomEvent<{ previousDigest: string; digest: string }>
      ).detail;
      update(previousDigest, digest);
    };
    window.addEventListener(EVENT, listener);
    return () => window.removeEventListener(EVENT, listener);
  }, [update]);
}
