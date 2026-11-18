import { loadSite } from "@/lib/site";

// Built from the published site at build time. The design comes in phase 3A.
export default async function Home() {
  const site = await loadSite();
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
