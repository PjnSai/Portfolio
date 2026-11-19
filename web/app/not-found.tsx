import type { Metadata } from "next";
import "./(site)/site.css";

export const metadata: Metadata = { title: "Page not found", robots: { index: false } };

// Replaces Next's built-in page, which sets style attributes the policy blocks.
export default function NotFound() {
  return (
    <div className="site">
      <main id="main" className="wrap not-found">
        <h1>Page not found</h1>
        <p>
          <a href="/">Go to the home page</a>
        </p>
      </main>
    </div>
  );
}
