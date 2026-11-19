import type { Metadata } from "next";
import { Placeholder } from "@/components/public/bits";
import { ProjectCard } from "@/components/public/ProjectCard";
import { pageModel } from "@/lib/public/content";
import { loadSite } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const site = await loadSite();
  const model = pageModel(site);
  return {
    title: `Projects | ${model.name}`,
    ...(model.projects.length === 0 ? { robots: { index: false, follow: false } } : {}),
  };
}

// Every project as a plain list: the fallback for the showcase and a page to link to.
export default async function ProjectsPage() {
  const site = await loadSite();
  const model = pageModel(site);
  return (
    <div className="wrap page">
      <header className="page__header">
        <p className="label">All projects</p>
        <h1 tabIndex={-1}>Projects</h1>
      </header>
      {model.projects.length === 0 ? (
        <Placeholder>TODO: add the first project.</Placeholder>
      ) : (
        <ol className="cards cards--list">
          {model.projects.map((project) => (
            <li key={project.id}>
              <ProjectCard project={project} site={site} level={2} />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
