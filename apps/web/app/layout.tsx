import { cookies } from "next/headers";
import type { Metadata } from "next";

import "./globals.css";
import { localized } from "../lib/ui-copy";
import { LocaleProvider } from "../lib/locale-context";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../lib/locale";

export async function generateMetadata(): Promise<Metadata> {
  const locale = resolveLocale(
    (await cookies()).get(LOCALE_COOKIE_NAME)?.value,
  );
  return {
    title: localized(
      locale,
      "Wukong · 商品營運",
      "Wukong · Listing operations",
    ),
    description: localized(
      locale,
      "以證據為本的商品上架營運。",
      "Evidence-backed product listing operations.",
    ),
  };
}

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  return (
    <html lang={locale}>
      <body>
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
