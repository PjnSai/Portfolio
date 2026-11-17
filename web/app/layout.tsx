import type { Metadata } from "next";
import { connection } from "next/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pujan Shahi",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page is rendered per request, so its scripts and styles carry the
  // nonce from this request's Content-Security-Policy (see proxy.ts).
  await connection();

  return (
    <html lang="en-GB">
      <body>{children}</body>
    </html>
  );
}
