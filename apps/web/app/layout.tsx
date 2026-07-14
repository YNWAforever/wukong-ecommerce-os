import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "Wukong · Opak Cellar",
  description: "Evidence-backed product listing operations for Opak Cellar.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}
