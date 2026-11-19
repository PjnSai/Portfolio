import type { ProjectEntry } from "@/lib/public/content";
import { pageHref, pageInfo, type PageInfo } from "@/lib/public/pagination";
import type { PublicSite } from "@/lib/site";
import { Placeholder } from "./bits";
import { ProjectCard } from "./ProjectCard";

function Pagination({ info }: { info: PageInfo }) {
  if (info.pages < 2) return null;
  return (
    <nav className="pages" aria-label="Project pages">
      {info.prev ? (
        <a className="pages__step" href={info.prev} rel="prev">
          Previous<span className="visually-hidden"> page</span>
        </a>
      ) : null}
      <ol className="pages__list">
        {info.links.map((link) => (
          <li key={link.page}>
            <a href={link.href} aria-current={link.current ? "page" : undefined}>
              <span className="visually-hidden">Page </span>
              {link.page}
            </a>
          </li>
        ))}
      </ol>
      {info.next ? (
        <a className="pages__step" href={info.next} rel="next">
          Next<span className="visually-hidden"> page</span>
        </a>
      ) : null}
    </nav>
  );
}

/** One page of the plain project list, with plain links to the others. */
export function ProjectPage({
  projects,
  site,
  page,
}: {
  projects: ProjectEntry[];
  site: PublicSite;
  page: number;
}) {
  const info = pageInfo(projects.length, page);
  const shown = projects.slice(info.start, info.end);
  return (
    <div className="wrap page">
      <header className="page__header">
        <p className="label">
          All projects
          {info.pages > 1 && !info.outOfRange ? ` / page ${page} of ${info.pages}` : ""}
        </p>
        <h1 tabIndex={-1}>{page > 1 && !info.outOfRange ? `Projects, page ${page}` : "Projects"}</h1>
      </header>
      {projects.length === 0 ? (
        <Placeholder>TODO: add the first project.</Placeholder>
      ) : info.outOfRange ? (
        <div className="pages__missing">
          <p>
            There is no page {page} of projects. The list has {info.pages}{" "}
            {info.pages === 1 ? "page" : "pages"}.
          </p>
          <p>
            <a href={pageHref(1)}>Go to the first page of projects</a>
          </p>
        </div>
      ) : (
        <>
          <ol className="cards cards--list" start={info.start + 1}>
            {shown.map((project) => (
              <li key={project.id}>
                <ProjectCard project={project} site={site} level={2} />
              </li>
            ))}
          </ol>
          <Pagination info={info} />
        </>
      )}
    </div>
  );
}
