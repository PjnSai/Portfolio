import { accentFor, monthLabel, STATUS_LABELS, type ProjectEntry } from "@/lib/public/content";
import { Markdown, safeHref } from "@/lib/markdown";
import type { PublicSite } from "@/lib/site";
import { Button, Picture, Tags } from "./bits";

type Props = {
  project: ProjectEntry;
  site: PublicSite;
  /** h3 under a section heading on the home page, h2 on /projects. */
  level?: 2 | 3;
  /** The label/value fields and links too, for the showcase's detail sheet. */
  detail?: boolean;
};

export function ProjectCard({ project, site, level = 3, detail = false }: Props) {
  const data = project.data;
  const Heading = level === 2 ? "h2" : "h3";
  const image = data.images[0];
  const when = data.created ? monthLabel(data.created) : "";
  const links = detail ? data.links.filter((link) => safeHref(link.url)) : [];
  const fields = detail ? data.fields : [];
  return (
    <article className="card" data-accent={accentFor(data.colour)} id={`project-${project.slug}`}>
      <div className="card__media">
        <Picture
          slot={image}
          media={image?.media ? site.media[image.media] : undefined}
          sizes="(min-width: 1000px) 400px, 100vw"
          placeholder="TODO: screenshot"
        />
      </div>
      <div className="card__body">
        <p className="card__meta">
          <span className="card__status">{STATUS_LABELS[data.status] ?? "In progress"}</span>
          {when ? <span>{when}</span> : null}
          {data.category ? <span>{data.category}</span> : null}
        </p>
        <Heading className="card__title">
          <a href={`/projects/${project.slug}`}>{data.title}</a>
        </Heading>
        {data.summary ? <Markdown source={data.summary} headingLevel={level + 1} /> : null}
        <Tags tags={data.tags} label={`Built with, ${data.title}`} />
        {fields.length > 0 || links.length > 0 ? (
          <div className="card__more">
            {fields.length > 0 ? (
              <dl className="facts">
                {fields.map((field) => (
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
          </div>
        ) : null}
      </div>
    </article>
  );
}
