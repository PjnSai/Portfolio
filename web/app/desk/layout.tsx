import type { Metadata } from "next";
import { AdminApp } from "@/components/admin/AdminApp";

// Not linked from the public site. Cloudflare Access guards this path and the
// admin API; the path name is not a secret.
export const metadata: Metadata = {
  title: "Site admin",
  robots: { index: false, follow: false, nocache: true },
};

export default function AdminLayout({ children }: LayoutProps<"/desk">) {
  return <AdminApp>{children}</AdminApp>;
}
