import type { Metadata } from "next";
import { fontVariables } from "@/lib/fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Pujan Shahi",
};

// Every page is built ahead of time; the policy in out/_headers lists the
// hashes of each page's inline scripts (see scripts/write-headers.ts).
export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en-GB" className={fontVariables}>
      <body>{children}</body>
    </html>
  );
}
