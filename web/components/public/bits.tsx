// Small building blocks of the public pages. Server components: no JavaScript
// reaches the browser for any of these.

import type { ReactNode } from "react";
import { apiOrigin } from "@/lib/api-base";
import type { Accent, ImageSlot, Stat } from "@/lib/public/content";
import type { SiteMedia } from "@/lib/site";
import { srcset } from "@/lib/site";

export function SkipLink() {
  return (
    <a className="skip-link" href="#main">
      Skip to content
    </a>
  );
}

export function SectionHeader({
  number,
  label,
  title,
  id,
}: {
  number: string;
  label: string;
  title: string;
  id: string;
}) {
  return (
    <header className="section-header">
      <p className="label">
        {number} / {label}
      </p>
      <h2 id={id} tabIndex={-1}>
        {title}
      </h2>
    </header>
  );
}

type ButtonProps = {
  href: string;
  children: ReactNode;
  variant?: "fill" | "outline";
  external?: boolean;
};

/** A link styled as a button: ink fill or ink outline, never a primary fill alone. */
export function Button({ href, children, variant = "fill", external = false }: ButtonProps) {
  return (
    <a
      className={`btn btn--${variant}`}
      href={href}
      {...(external ? { rel: "noopener noreferrer" } : {})}
    >
      {children}
    </a>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return <li className="tag">{children}</li>;
}

export function Tags({ tags, label }: { tags: readonly string[]; label: string }) {
  if (tags.length === 0) return null;
  return (
    <ul className="tags" aria-label={label}>
      {tags.map((tag) => (
        <Tag key={tag}>{tag}</Tag>
      ))}
    </ul>
  );
}

export function StatTile({ stat, accent }: { stat: Stat; accent: Accent }) {
  return (
    <div className="tile" data-accent={accent}>
      <p className="tile__value">{stat.value}</p>
      <p className="tile__label">{stat.label}</p>
    </div>
  );
}

const TILE_ACCENTS: Accent[] = ["1", "2", "3", "4"];

export function StatTiles({ stats }: { stats: readonly Stat[] }) {
  if (stats.length === 0) return null;
  return (
    <div className="tiles">
      {stats.map((stat, index) => (
        <StatTile key={stat.label} stat={stat} accent={TILE_ACCENTS[index % 4]} />
      ))}
    </div>
  );
}

/** A visible placeholder for content the owner has not added yet (SPEC 17). */
export function Placeholder({ children }: { children: ReactNode }) {
  return <p className="placeholder">{children}</p>;
}

type PictureProps = {
  slot: ImageSlot | undefined;
  media: SiteMedia | undefined;
  sizes: string;
  placeholder: string;
  eager?: boolean;
};

/** An image from the API with its WebP widths, or a hatched placeholder. */
export function Picture({ slot, media, sizes, placeholder, eager = false }: PictureProps) {
  const sources = media?.sources ?? [];
  if (!slot || !media || sources.length === 0) {
    return (
      <div className="picture picture--empty">
        <span>{placeholder}</span>
      </div>
    );
  }
  const origin = apiOrigin(process.env.API_BASE_URL);
  const largest = sources[sources.length - 1];
  return (
    // Static export: next/image would add nothing here, the API already serves sized WebP.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      className="picture"
      src={`${origin}${largest.url}`}
      srcSet={srcset(media, origin)}
      sizes={sizes}
      width={media.width}
      height={media.height}
      alt={slot.alt}
      loading={eager ? "eager" : "lazy"}
      decoding="async"
    />
  );
}
