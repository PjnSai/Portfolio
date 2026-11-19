import type { PageSection } from "@/lib/public/content";

type Props = { name: string; sections: readonly PageSection[]; contact?: string };

// Links are real fragments on the home page ("/#projects"), so they work with no
// JavaScript, from any page, and from a shared URL. NavEnhancer adds the burger
// menu and the current-section marker when JavaScript runs.
export function SiteNav({ name, sections, contact }: Props) {
  return (
    <header className="nav" data-nav>
      <div className="nav__inner wrap">
        <a className="nav__name" href="/">
          {name}
        </a>
        <nav className="nav__menu" aria-label="Main">
          <button
            type="button"
            className="nav__burger"
            aria-expanded="false"
            aria-controls="site-menu"
            data-burger
          >
            Menu
          </button>
          <ul className="nav__links" id="site-menu">
            {sections.map((entry) => (
              <li key={entry.anchor}>
                <a href={`/#${entry.anchor}`} data-nav-link>
                  <span className="nav__num" aria-hidden="true">
                    {entry.number}
                  </span>
                  {entry.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>
        {contact ? (
          <a className="btn btn--fill nav__cta" href={`/#${contact}`}>
            Get in touch
          </a>
        ) : null}
      </div>
    </header>
  );
}

/** The numbered pager on the right edge, on wide screens only (CSS hides it below 1000 px). */
export function SectionPager({ sections }: { sections: readonly PageSection[] }) {
  if (sections.length === 0) return null;
  return (
    <nav className="pager" aria-label="Sections">
      <ol>
        {sections.map((entry) => (
          <li key={entry.anchor}>
            <a href={`/#${entry.anchor}`} data-nav-link>
              <span className="pager__num" aria-hidden="true">
                {entry.number}
              </span>
              <span className="pager__label">
                <span className="visually-hidden">Go to </span>
                {entry.label}
              </span>
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Footer({ name, hasProjects }: { name: string; hasProjects: boolean }) {
  return (
    <footer className="footer">
      <div className="wrap footer__inner">
        <p>
          © {new Date().getFullYear()} {name}
        </p>
        <ul className="footer__links">
          {hasProjects ? (
            <li>
              <a href="/projects">All projects</a>
            </li>
          ) : null}
          <li>
            <a href="#top">Back to top</a>
          </li>
        </ul>
      </div>
    </footer>
  );
}
