import type { Metadata } from "next";

import { NavBar } from "@/components/NavBar";
import { COPY } from "@/lib/copy";

import "./globals.css";

export const metadata: Metadata = {
  title: `${COPY.appName} — ${COPY.tagline}`,
  description:
    "Real-time stock news intelligence for short-term traders. Evidence, not instructions.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <NavBar />
        <main className="mx-auto max-w-[1600px] px-4 py-4">{children}</main>
        <footer className="mt-8 border-t border-hairline">
          <div className="mx-auto max-w-[1600px] px-4 py-3 text-[11px] text-muted">
            {COPY.legend}
          </div>
        </footer>
      </body>
    </html>
  );
}
