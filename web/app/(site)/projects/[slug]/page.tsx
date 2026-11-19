import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Button, Picture, Placeholder, Tags } from "@/components/public/bits";
import { Markdown, safeHref } from "@/lib/markdown";
import { accentFor, monthLabel, pageModel, STATUS_LABELS } from "@/lib/public/content";
import { loadSite } from "@/lib/site";

export const dynamicParams = false;

// A static export must build at least one page here. With no projects yet,
// one placeholder page stands in, kept out of search.
const NO_PROJECTS = "none";

export async function generateStaticParams() {
  const site = await loadSite();
  const slugs = pageModel(site).projects.map((project) => ({ slug: project.slug }));
  return slugs.length > 0 ? slugs : [{ slug: NO_PROJECTS }];
}

async function find(slug: string) {
  const site = await loadSite();
  const project = pageModel(site).projects.find((entry) => entry.slug === slug);
  return { site, project };
}

export async function generateMetadata({ params }: PageProps<"/projects/[slug]">): Promise<Metadata> {
  const { project } = await find((await params).slug);
  return project ? { title: project.data.title } : { robots: { index: false, follow: false } };
}

export default async function CaseStudy({ params }: PageProps<"/projects/[slug]">) {
  const slug = (await params).slug;
  const { site, project } = await find(slug);
  if (!project && slug === NO_PROJECTS) {
    return (
      <div className="wrap page">
        <h1 tabIndex={-1}>Projects</h1>
        <Placeholder>TODO: add the first project.</Placeholder>
      </div>
    );
  }
  if (!project) notFound();
  const data = project.data;
  const links = data.links.filter((link) => safeHref(link.url));
  return (
    <article className="case">
      <header className="case__header" data-accent={accentFor(data.colour)}>
        <div className="wrap">
          <p className="label">
            <a href="/projects">Projects</a> / {STATUS_LABELS[data.status] ?? "In progress"}
            {data.created ? ` / ${monthLabel(data.created)}` : ""}
          </p>
          <h1 tabIndex={-1}>{data.title}</h1>
          {data.summary ? <Markdown source={data.summary} headingLevel={2} /> : null}
          <Tags tags={data.tags} label="Built with" />
        </div>
      </header>
      <div className="wrap case__grid">
        <div className="case__main">
          {data.images.length > 0 ? (
            <ul className="gallery">
              {data.images.map((image, index) => (
                <li key={`${image.media ?? "empty"}-${index}`}>
                  <figure>
                    <Picture
                      slot={image}
                      media={image.media ? site.media[image.media] : undefined}
                      sizes="(min-width: 1000px) 800px, 100vw"
                      placeholder="TODO: image"
                      eager={index === 0}
                    />
                    {image.caption ? <figcaption>{image.caption}</figcaption> : null}
                  </figure>
                </li>
              ))}
            </ul>
          ) : null}
          <h2 tabIndex={-1}>Case study</h2>
          {data.body ? (
            <Markdown source={data.body} />
          ) : (
            <p className="placeholder">TODO: problem, role, decisions, what was learned.</p>
          )}
        </div>
        <aside className="case__aside" aria-label="Project facts">
          {data.fields.length > 0 ? (
            <dl className="facts">
              {data.fields.map((field) => (
                <div key={field.label}>
                  <dt>{field.label}</dt>
                  <dd>{field.value}</dd>
                </div>
              ))}
            </dl>
          ) : null}
          {links.length > 0 ? (
            <ul className="link-list">
              {links.map((link) => (
                <li key={link.url}>
                  <Button href={link.url} variant="outline" external>
                    {link.label}
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </aside>
      </div>
    </article>
  );
}
