export const LOCALE_COOKIE_NAME = "locale";
export const DEFAULT_LOCALE = "zh-Hant";

export type Locale = "zh-Hant" | "en";

const VALID_LOCALES: readonly Locale[] = ["zh-Hant", "en"];

export function resolveLocale(value: string | undefined): Locale {
  if (value && (VALID_LOCALES as readonly string[]).includes(value)) {
    return value as Locale;
  }
  return DEFAULT_LOCALE;
}
