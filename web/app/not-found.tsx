import type { Metadata } from "next";
import { SiteChrome } from "@/components/public/SiteChrome";
import { pageModel } from "@/lib/public/content";
import { loadSite } from "@/lib/site";
import "./(site)/site.css";

// Next adds <meta name="robots" content="noindex"> to this page itself.
export const metadata: Metadata = { title: "Page not found" };

// Pages serves this as 404.html, with status 404, for any path it has no file
// for. Replaces Next's built-in page, which sets style attributes the policy blocks.
export default async function NotFound() {
  const site = await loadSite();
  const hasProjects = pageModel(site).projects.length > 0;
  return (
    <SiteChrome site={site}>
      <div className="wrap page not-found">
        <p className="label">Error 404</p>
        <h1 tabIndex={-1}>Page not found</h1>
        <p>Nothing is at this address. It may have moved, or the link may be mistyped.</p>
        <ul className="link-list">
          <li>
            <a className="btn btn--fill" href="/">
              Go to the home page
            </a>
          </li>
          {hasProjects ? (
            <li>
              <a className="btn btn--outline" href="/projects">
                See all projects
              </a>
            </li>
          ) : null}
        </ul>
      </div>
    </SiteChrome>
  );
}
