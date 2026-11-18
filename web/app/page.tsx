import type { Metadata } from "next";
import { loadSite } from "@/lib/site";

// Built from the published site at build time. The design comes in phase 3A.
// With nothing published the home page is a placeholder and stays out of search.
export async function generateMetadata(): Promise<Metadata> {
  const site = await loadSite();
  return site.sections.length === 0 ? { robots: { index: false, follow: false } } : {};
}

export default async function Home() {
  const site = await loadSite();
  if (site.sections.length === 0) {
    return (
      <main>
        <h1>{site.settings.title || "Portfolio"}</h1>
        <p>Site coming soon</p>
      </main>
    );
  }
  return (
    <main>
      <h1>Pujan Shahi</h1>
      {site.sections.map((section, index) => (
        <section key={index}>
          <h2>{section.title}</h2>
        </section>
      ))}
    </main>
  );
}
