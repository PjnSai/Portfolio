"use client";

// Shown in place of a page section if it throws while running in the browser.
// The pages are static files, so this can only follow a script error after
// load; the nav and footer stay, and the static content is never lost on reload.
export default function SiteError({ reset }: { error: Error; reset: () => void }) {
  return (
    <div className="wrap page not-found">
      <p className="label">Error</p>
      <h1 tabIndex={-1}>Something went wrong</h1>
      <p>This page could not be shown. Reloading it usually helps.</p>
      <ul className="link-list">
        <li>
          <button type="button" className="btn btn--fill" onClick={reset}>
            Try again
          </button>
        </li>
        <li>
          <a className="btn btn--outline" href="/">
            Go to the home page
          </a>
        </li>
      </ul>
    </div>
  );
}
