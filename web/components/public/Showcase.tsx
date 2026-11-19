import type { ProjectEntry } from "@/lib/public/content";
import { LAYOUTS, LAYOUT_NAMES, layoutOf } from "@/lib/public/showcase";
import type { PublicSite } from "@/lib/site";
import { ProjectCard } from "./ProjectCard";

const pad = (n: number) => String(n).padStart(2, "0");

// The project deck. Prerendered as a plain list of cards, which is what a
// visitor without JavaScript gets. lib/public/showcase.ts turns it into the
// owner's 3D layout (or the swipe carousel) and shows the controls, which are
// prerendered hidden because they do nothing without it.
export function Showcase({ projects, site }: { projects: ProjectEntry[]; site: PublicSite }) {
  const layout = layoutOf(site.settings.showcase_layout);
  const switcher = site.settings.layout_switcher === true && projects.length > 1;
  return (
    <div className="showcase" data-showcase data-layout={layout}>
      {switcher ? (
        <fieldset className="showcase__switch" data-showcase-switch hidden>
          <legend className="label">Layout</legend>
          {LAYOUTS.map((name) => (
            <label key={name}>
              <input type="radio" name="showcase-layout" value={name} defaultChecked={name === layout} />
              {LAYOUT_NAMES[name]}
            </label>
          ))}
        </fieldset>
      ) : null}
      <ul className="cards showcase__deck" data-showcase-deck>
        {projects.map((project) => (
          <li key={project.id} className="showcase__slot" data-slot>
            <ProjectCard project={project} site={site} detail />
          </li>
        ))}
      </ul>
      <div className="showcase__controls" data-showcase-controls hidden>
        <button type="button" className="btn btn--outline" data-showcase-prev>
          Previous<span className="visually-hidden"> project</span>
        </button>
        <p className="showcase__count" aria-hidden="true" data-showcase-count>
          01 / {pad(projects.length)}
        </p>
        <button type="button" className="btn btn--outline" data-showcase-next>
          Next<span className="visually-hidden"> project</span>
        </button>
        <ol className="showcase__dots">
          {projects.map((project, index) => (
            <li key={project.id}>
              <button
                type="button"
                className="showcase__dot"
                data-showcase-dot
                aria-label={`Project ${index + 1} of ${projects.length}: ${project.data.title}`}
              />
            </li>
          ))}
        </ol>
        <p className="visually-hidden" aria-live="polite" data-showcase-status />
      </div>
      <dialog className="sheet" aria-labelledby="showcase-sheet-title" data-showcase-sheet>
        <div className="sheet__inner">
          <p className="sheet__bar">
            <button type="button" className="btn btn--outline" data-showcase-close>
              Close<span className="visually-hidden"> project details</span>
            </button>
          </p>
          <div data-showcase-sheet-body />
        </div>
      </dialog>
    </div>
  );
}
