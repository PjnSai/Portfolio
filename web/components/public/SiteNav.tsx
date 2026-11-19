import { DisplayMenu, type PaletteOption } from "@/components/public/DisplayMenu";
import type { PageSection } from "@/lib/public/content";
import { FOOTER_PAGES } from "@/lib/public/footer-pages";

type Props = {
  name: string;
  sections: readonly PageSection[];
  contact?: string;
  palettes?: readonly PaletteOption[];
  defaultId?: string;
};

// Links are real fragments on the home page ("/#projects"), so they work with no
// JavaScript, from any page, and from a shared URL. NavEnhancer adds the burger
// menu and the current-section marker when JavaScript runs.
export function SiteNav({ name, sections, contact, palettes = [], defaultId }: Props) {
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
        <DisplayMenu palettes={palettes} defaultId={defaultId} />
      </div>
    </header>
  );
}

/** The numbered pager on the right edge: a dot rail under 1000 px, a panel
    above. The Next section button is shown by NavEnhancer; without
    JavaScript the links and the footer's Back to top still work. */
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
      <button type="button" className="pager__next" data-pager-next hidden>
        <svg className="pager__arrow" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" focusable="false">
          <path d="M8 2v11M3 8l5 5 5-5" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
        <span className="pager__next-label" data-pager-next-label>
          Next section
        </span>
      </button>
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
        <nav aria-label="Footer">
          <ul className="footer__links">
            {hasProjects ? (
              <li>
                <a href="/projects">All projects</a>
              </li>
            ) : null}
            {FOOTER_PAGES.map((page) => (
              <li key={page.route}>
                <a href={page.route}>{page.label}</a>
              </li>
            ))}
            <li>
              <a href="#top">Back to top</a>
            </li>
          </ul>
        </nav>
      </div>
    </footer>
  );
}
