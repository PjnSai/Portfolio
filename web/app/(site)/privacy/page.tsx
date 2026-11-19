import type { Metadata } from "next";
import { PrivacyPage } from "@/components/public/FooterPages";
import { pageModel } from "@/lib/public/content";
import { footerMetadata } from "@/lib/public/meta";
import { loadSite } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const site = await loadSite();
  return footerMetadata(site, pageModel(site), "/privacy");
}

export default async function Page() {
  const site = await loadSite();
  return <PrivacyPage name={pageModel(site).name} />;
}
