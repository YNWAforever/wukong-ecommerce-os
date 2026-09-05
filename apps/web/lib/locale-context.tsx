"use client";
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_LOCALE, setLocaleCookie, type Locale } from "./locale";
const LocaleContext = createContext<{
  locale: Locale;
  changeLocale: (locale: Locale) => void;
} | null>(null);
export function LocaleProvider({
  locale: resolvedLocale,
  children,
}: {
  locale: Locale;
  children: ReactNode;
}) {
  const [locale, setLocale] = useState(resolvedLocale);
  const router = useRouter();
  useEffect(() => setLocale(resolvedLocale), [resolvedLocale]);
  function changeLocale(next: Locale) {
    setLocale(next);
    setLocaleCookie(next);
    document.documentElement.lang = next;
    router.refresh();
  }
  return (
    <LocaleContext.Provider value={{ locale, changeLocale }}>
      {children}
    </LocaleContext.Provider>
  );
}
export function useLocale() {
  return useContext(LocaleContext)?.locale ?? DEFAULT_LOCALE;
}
export function useLocalePreference() {
  return useContext(LocaleContext);
}
