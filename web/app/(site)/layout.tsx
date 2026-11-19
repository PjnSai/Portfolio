import { SiteChrome } from "@/components/public/SiteChrome";
import { loadSite } from "@/lib/site";
import "./site.css";

export default async function SiteLayout({ children }: LayoutProps<"/">) {
  return <SiteChrome site={await loadSite()}>{children}</SiteChrome>;
}
