import {
  dateRange,
  itemsOf,
  mediaFor,
  statsFor,
  type Education,
  type Experience,
  type ImageSlot,
  type Link,
  type PageModel,
  type PageSection,
  type SkillGroup,
} from "@/lib/public/content";
import { Markdown, safeHref } from "@/lib/markdown";
import type { PublicSite, SiteSection } from "@/lib/site";
import { Button, Picture, Placeholder, SectionHeader, StatTiles, Tags } from "./bits";
import { ProjectCard } from "./ProjectCard";

const text = (value: unknown) => (typeof value === "string" ? value : "");

export function Hero({ site, model }: { site: PublicSite; model: PageModel }) {
  const hero = model.hero;
  const role = text(hero?.role);
  const body = text(hero?.body);
  const availability = text(hero?.availability);
  const projects = model.sections.find((entry) => entry.type === "projects");
  return (
    <section className="hero" aria-labelledby="hero-name">
      <div className="hero__inner wrap">
        <div className="hero__text">
          <h1 id="hero-name" className="hero__name" tabIndex={-1}>
            {model.name}
          </h1>
          <p className="hero__role">{role || "TODO: role title"}</p>
          {body ? <Markdown source={body} /> : <Placeholder>TODO: short summary</Placeholder>}
          {projects || model.contact ? (
            <p className="hero__actions">
              {projects ? <Button href={`#${projects.anchor}`}>See projects</Button> : null}
              {model.contact ? (
                <Button href={`#${model.contact.anchor}`} variant="outline">
                  Get in touch
                </Button>
              ) : null}
            </p>
          ) : null}
          {availability ? <p className="hero__availability">{availability}</p> : null}
        </div>
        <div className="portrait">
          <div className="portrait__frame">
            <Picture
              slot={model.photo}
              media={mediaFor(site, model.photo)}
              sizes="(min-width: 760px) 40vw, 100vw"
              placeholder="TODO: portrait"
              eager
            />
          </div>
        </div>
      </div>
    </section>
  );
}

/** Every skill in one band under the hero. Static for now; the full list is in the Skills section. */
export function SkillsStrip({ site }: { site: PublicSite }) {
  const skills = site.sections
    .filter((section) => section.type === "skills")
    .flatMap((section) => itemsOf<SkillGroup>(section))
    .flatMap((group) => group.data.skills);
  if (skills.length === 0) return null;
  return (
    <div className="strip" aria-hidden="true">
      <ul className="strip__list">
        {skills.map((skill, index) => (
          <li key={`${skill}-${index}`}>{skill}</li>
        ))}
      </ul>
    </div>
  );
}

const EMPTY: Record<string, string> = {
  projects: "TODO: add the first project.",
  experience: "TODO: add work experience.",
  education: "TODO: add education.",
  skills: "TODO: add skill groups.",
  links: "TODO: add professional links.",
  gallery: "TODO: add images.",
};

function Empty({ type }: { type: string }) {
  return <Placeholder>{EMPTY[type] ?? "TODO: add content."}</Placeholder>;
}

function Body({ section }: { section: SiteSection }) {
  const body = text(section.body);
  return body ? <Markdown source={body} /> : null;
}

function LinkList({ links: all }: { links: readonly Link[] }) {
  const links = all.filter((link) => safeHref(link.url)?.startsWith("https:"));
  if (links.length === 0) return <Empty type="links" />;
  return (
    <ul className="link-list">
      {links.map((link) => (
        <li key={link.url}>
          <a className="btn btn--outline" href={link.url} rel="noopener noreferrer me">
            {link.label}
          </a>
        </li>
      ))}
    </ul>
  );
}

function Timeline({ entries }: { entries: { key: string; title: string; place: string; when: string; extra?: string; summary: string; tags?: string[] }[] }) {
  return (
    <ol className="timeline">
      {entries.map((entry) => (
        <li key={entry.key} className="timeline__entry">
          <p className="timeline__when">{entry.when}</p>
          <div className="timeline__body">
            <h3>{entry.title}</h3>
            <p className="timeline__place">
              {entry.place}
              {entry.extra ? ` · ${entry.extra}` : ""}
            </p>
            {entry.summary ? <Markdown source={entry.summary} /> : null}
            {entry.tags ? <Tags tags={entry.tags} label={`Tags, ${entry.title}`} /> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}

function Content({ entry, site, model }: { entry: PageSection; site: PublicSite; model: PageModel }) {
  const { section } = entry;
  switch (entry.type) {
    case "about":
      return (
        <div className="about">
          <div>
            {text(section.body) ? <Body section={section} /> : <Placeholder>TODO: about me</Placeholder>}
            {text(section.location) ? (
              <p className="about__location">Based in {text(section.location)}</p>
            ) : null}
          </div>
          <StatTiles stats={statsFor(site, model)} />
        </div>
      );
    case "projects": {
      const items = itemsOf(section).map((item) => item.id);
      const projects = model.projects.filter((project) => items.includes(project.id));
      return (
        <>
          <Body section={section} />
          {projects.length === 0 ? (
            <Empty type="projects" />
          ) : (
            <ul className="cards">
              {projects.map((project) => (
                <li key={project.id}>
                  <ProjectCard project={project} site={site} />
                </li>
              ))}
            </ul>
          )}
          {projects.length > 0 ? (
            <p className="section__more">
              <a href="/projects">View all projects</a>
            </p>
          ) : null}
        </>
      );
    }
    case "experience": {
      const items = itemsOf<Experience>(section);
      return (
        <>
          <Body section={section} />
          {items.length === 0 ? (
            <Empty type="experience" />
          ) : (
            <Timeline
              entries={items.map(({ id, data }) => ({
                key: id,
                title: data.role,
                place: data.organisation,
                extra: data.location,
                when: dateRange(data.start, data.end),
                summary: data.summary,
                tags: data.tags,
              }))}
            />
          )}
        </>
      );
    }
    case "education": {
      const items = itemsOf<Education>(section);
      return (
        <>
          <Body section={section} />
          {items.length === 0 ? (
            <Empty type="education" />
          ) : (
            <Timeline
              entries={items.map(({ id, data }) => ({
                key: id,
                title: data.qualification,
                place: data.institution,
                extra: data.grade,
                when: dateRange(data.start, data.end),
                summary: data.summary,
              }))}
            />
          )}
        </>
      );
    }
    case "skills": {
      const groups = itemsOf<SkillGroup>(section);
      return (
        <>
          <Body section={section} />
          {groups.length === 0 ? (
            <Empty type="skills" />
          ) : (
            <div className="skill-groups">
              {groups.map(({ id, data }) => (
                <div key={id} className="skill-group">
                  <h3>{data.name}</h3>
                  <Tags tags={data.skills} label={data.name} />
                </div>
              ))}
            </div>
          )}
        </>
      );
    }
    case "contact":
      return (
        <>
          <Body section={section} />
          <LinkList links={model.links} />
        </>
      );
    case "links":
      return <LinkList links={itemsOf<Link>(section).map((item) => item.data)} />;
    case "gallery": {
      const images = itemsOf<ImageSlot>(section);
      return images.length === 0 ? (
        <Empty type="gallery" />
      ) : (
        <ul className="gallery">
          {images.map(({ id, data }) => (
            <li key={id}>
              <figure>
                <Picture
                  slot={data}
                  media={mediaFor(site, data)}
                  sizes="(min-width: 760px) 50vw, 100vw"
                  placeholder="TODO: image"
                />
                {data.caption ? <figcaption>{data.caption}</figcaption> : null}
              </figure>
            </li>
          ))}
        </ul>
      );
    }
    default:
      return text(section.body) ? <Body section={section} /> : <Empty type="text" />;
  }
}

export function SectionBlock({ entry, site, model }: { entry: PageSection; site: PublicSite; model: PageModel }) {
  return (
    <section
      id={entry.anchor}
      className={`section section--${entry.type}`}
      aria-labelledby={`${entry.anchor}-title`}
      data-section
    >
      <div className="wrap">
        <SectionHeader
          number={entry.number}
          label={entry.label}
          title={entry.section.title}
          id={`${entry.anchor}-title`}
        />
        <Content entry={entry} site={site} model={model} />
      </div>
    </section>
  );
}
