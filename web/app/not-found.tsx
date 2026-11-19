import type { Metadata } from "next";
import "./(site)/site.css";

export const metadata: Metadata = { title: "Page not found", robots: { index: false } };

// Replaces Next's built-in page, which sets style attributes the policy blocks.
export default function NotFound() {
  return (
    <div className="site">
      <main id="main" className="wrap not-found">
        <h1>Page not found</h1>
        <p>Nothing is at this address. If it was a page of projects, that page does not exist.</p>
        <ul className="link-list">
          <li>
            <a href="/">Go to the home page</a>
          </li>
          <li>
            <a href="/projects">See the list of projects</a>
          </li>
        </ul>
      </main>
    </div>
  );
}
