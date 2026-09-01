import { cookies } from "next/headers";
import type { Metadata } from "next";

import "./globals.css";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../lib/locale";

export const metadata: Metadata = {
  title: "Wukong · Opak Cellar",
  description: "Evidence-backed product listing operations for Opak Cellar.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const cookieStore = await cookies();
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE_NAME)?.value);

  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
