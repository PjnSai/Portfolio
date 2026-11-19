import type { Metadata } from "next";
import { HowBuiltPage } from "@/components/public/FooterPages";
import { pageModel } from "@/lib/public/content";
import { footerMetadata } from "@/lib/public/meta";
import { loadSite } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const site = await loadSite();
  return footerMetadata(site, pageModel(site), "/how-this-site-is-built");
}

export default function Page() {
  return <HowBuiltPage />;
}
