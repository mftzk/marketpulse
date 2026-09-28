import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "MarketPulse",
  description: "Real-time stock news intelligence for short-term traders.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
