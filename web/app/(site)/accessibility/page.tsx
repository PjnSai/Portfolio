import type { Metadata } from "next";
import { AccessibilityPage } from "@/components/public/FooterPages";
import { pageModel } from "@/lib/public/content";
import { footerMetadata } from "@/lib/public/meta";
import { loadSite } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const site = await loadSite();
  return footerMetadata(site, pageModel(site), "/accessibility");
}

export default function Page() {
  return <AccessibilityPage />;
}
