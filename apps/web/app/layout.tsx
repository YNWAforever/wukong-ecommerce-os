import { cookies } from "next/headers";
import type { Metadata } from "next";
import Script from "next/script";
import { Inter, Source_Serif_4 } from "next/font/google";
import { ADMIN_POPSTATE_BRIDGE_SCRIPT } from "../lib/admin-popstate-bridge";

import "./globals.css";
import { localized } from "../lib/ui-copy";
import { LocaleProvider } from "../lib/locale-context";
import { LOCALE_COOKIE_NAME, resolveLocale } from "../lib/locale";

// Self-hosted and preloaded at build time. "optional" means a face that is not
// ready by first paint is skipped for that page load rather than swapped in
// later, so a slow font never shifts layout or restored scroll positions.
// CJK glyphs fall through to the system Traditional Chinese faces. The display
// serif replaces Georgia, whose old-style figures turned the 0 in
// "Synthetic task 0" (and every vintage) into a lowercase o.
const inter = Inter({
  subsets: ["latin"],
  display: "optional",
  variable: "--font-inter",
});
const sourceSerif = Source_Serif_4({
  subsets: ["latin"],
  display: "optional",
  variable: "--font-serif",
});

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
    <html lang={locale} className={`${inter.variable} ${sourceSerif.variable}`}>
      <body>
        <Script id="admin-popstate-bridge" strategy="beforeInteractive">
          {ADMIN_POPSTATE_BRIDGE_SCRIPT}
        </Script>
        <LocaleProvider locale={locale}>{children}</LocaleProvider>
      </body>
    </html>
  );
}
