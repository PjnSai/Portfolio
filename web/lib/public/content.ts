// The published site document turned into what the public pages render:
// sections in the owner's order with anchors and numbers, projects with slugs,
// and counts taken from the published content (never typed-in numbers).

import type { PublicSite, SiteMedia, SiteSection } from "../site";

export type ImageSlot = { media: string | null; alt: string; caption?: string };

export type Project = {
  title: string;
  summary: string;
  body: string;
  status: "live" | "demo" | "local" | "in_progress";
  created?: string;
  category?: string;
  colour: string;
  tags: string[];
  links: { kind: string; label: string; url: string }[];
  fields: { label: string; value: string }[];
  images: ImageSlot[];
};

export type Experience = {
  organisation: string;
  role: string;
  location?: string;
  start: string;
  end?: string;
  summary: string;
  tags: string[];
};

export type Education = {
  institution: string;
  qualification: string;
  grade?: string;
  start: string;
  end?: string;
  summary: string;
};

export type SkillGroup = { name: string; skills: string[] };
export type Link = { label: string; url: string };

export type Item<T> = { id: string; data: T };

/** A card colour from the admin, as the slot it is painted with. */
export type Accent = "primary" | "1" | "2" | "3" | "4" | "ink";

const ACCENTS: Record<string, Accent> = {
  orange: "primary",
  blue: "1",
  pink: "2",
  yellow: "3",
  olive: "4",
  ink: "ink",
};

export const accentFor = (colour: string | undefined): Accent =>
  ACCENTS[colour ?? ""] ?? "primary";

export const STATUS_LABELS: Record<string, string> = {
  live: "Live",
  demo: "Demo",
  local: "Local",
  in_progress: "In progress",
};

const TYPE_LABELS: Record<string, string> = {
  about: "About",
  projects: "Projects",
  experience: "Experience",
  education: "Education",
  skills: "Skills",
  contact: "Contact",
  links: "Links",
};

export type PageSection = {
  type: string;
  /** The element id and the #fragment the nav links to. */
  anchor: string;
  /** Short name for the nav and the mono label, for example "Projects". */
  label: string;
  /** Two digits, counting from 01 after the hero. */
  number: string;
  section: SiteSection;
};

export type ProjectEntry = Item<Project> & { slug: string };

export type PageModel = {
  name: string;
  hero?: SiteSection;
  sections: PageSection[];
  projects: ProjectEntry[];
  contact?: PageSection;
  links: Link[];
  photo?: ImageSlot;
};

export function slugify(text: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  return slug || "section";
}

/** One slug per title, in order; a repeat gets -2, -3 and so on. */
export function uniqueSlugs(titles: readonly string[], taken: readonly string[] = []): string[] {
  const used = new Set(taken);
  return titles.map((title) => {
    const base = slugify(title);
    let slug = base;
    for (let n = 2; used.has(slug); n += 1) slug = `${base}-${n}`;
    used.add(slug);
    return slug;
  });
}

export function itemsOf<T>(section: SiteSection | undefined): Item<T>[] {
  const items = section?.items;
  return Array.isArray(items) ? (items as Item<T>[]) : [];
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

// "main" and "top" are used by the skip link and the page itself.
const RESERVED = ["main", "top", "site-nav", "site-menu"];

export function pageModel(site: PublicSite): PageModel {
  const hero = site.sections.find((section) => section.type === "hero");
  const rest = site.sections.filter((section) => section !== hero);
  // With a contact section, the links are shown inside it rather than on their own.
  const hasContact = rest.some((section) => section.type === "contact");
  const shown = rest.filter((section) => !(hasContact && section.type === "links"));
  const anchors = uniqueSlugs(
    shown.map((section) => {
      const type = section.type ?? "";
      return TYPE_LABELS[type] ? type : section.title;
    }),
    RESERVED,
  );
  const sections = shown.map((section, index) => {
    const type = section.type ?? "text";
    return {
      type,
      anchor: anchors[index],
      label: TYPE_LABELS[type] ?? section.title,
      number: String(index + 1).padStart(2, "0"),
      section,
    };
  });

  const projectItems = rest
    .filter((section) => section.type === "projects")
    .flatMap((section) => itemsOf<Project>(section));
  // /projects/page/ holds the list pages, so no project may be called "page".
  const slugs = uniqueSlugs(
    projectItems.map((item) => item.data.title),
    ["page"],
  );
  const projects = projectItems.map((item, index) => ({ ...item, slug: slugs[index] }));

  const about = rest.find((section) => section.type === "about");
  const photo = about?.photo as ImageSlot | null | undefined;

  return {
    name: text(hero?.name) || text(site.settings.title) || "Portfolio",
    hero,
    sections,
    projects,
    contact: sections.find((entry) => entry.type === "contact"),
    links: rest
      .filter((section) => section.type === "links")
      .flatMap((section) => itemsOf<Link>(section).map((item) => item.data)),
    photo: photo ?? undefined,
  };
}

export type Stat = { value: number; label: string };

/** Counts of what is published, for the stat tiles. Zero counts are left out. */
export function statsFor(site: PublicSite, model: PageModel): Stat[] {
  const count = (type: string) =>
    site.sections
      .filter((section) => section.type === type)
      .reduce((total, section) => total + itemsOf(section).length, 0);
  const skills = site.sections
    .filter((section) => section.type === "skills")
    .flatMap((section) => itemsOf<SkillGroup>(section))
    .reduce((total, group) => total + group.data.skills.length, 0);
  const stats: Stat[] = [
    { value: model.projects.length, label: model.projects.length === 1 ? "Project" : "Projects" },
    { value: count("experience"), label: count("experience") === 1 ? "Role" : "Roles" },
    {
      value: count("education"),
      label: count("education") === 1 ? "Qualification" : "Qualifications",
    },
    { value: skills, label: skills === 1 ? "Skill" : "Skills" },
  ];
  return stats.filter((stat) => stat.value > 0);
}

/** "2024-09" as "Sep 2024"; an empty end means the entry is current. */
export function monthLabel(value: string | undefined): string {
  const match = /^(\d{4})-(\d{2})$/.exec(value ?? "");
  if (!match) return "";
  const names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${names[Number(match[2]) - 1]} ${match[1]}`;
}

export function dateRange(start: string, end: string | undefined): string {
  return `${monthLabel(start)} to ${end ? monthLabel(end) : "now"}`;
}

export function mediaFor(site: PublicSite, slot: ImageSlot | undefined): SiteMedia | undefined {
  return slot?.media ? site.media[slot.media] : undefined;
}
