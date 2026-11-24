// The words of the footer pages (SPEC 3.10). They describe what the site does
// now. The contact form is described here; the CV download is still to come
// (docs/PROGRESS.md lists what remains).

import type { ReactNode } from "react";
import { REPORT_URL, REPOSITORY } from "@/lib/seo";
const REVIEWED = "23 November 2026";

function Doc({ label, title, lead, children }: { label: string; title: string; lead: string; children: ReactNode }) {
  return (
    <article className="wrap page doc">
      <header className="page__header">
        <p className="label">{label}</p>
        <h1 tabIndex={-1}>{title}</h1>
        <p className="doc__lead">{lead}</p>
      </header>
      <div className="doc__body">{children}</div>
      <p className="doc__date">Last reviewed {REVIEWED}.</p>
    </article>
  );
}

const External = ({ href, children }: { href: string; children: ReactNode }) => (
  <a href={href} rel="noopener noreferrer">
    {children}
  </a>
);

export function PrivacyPage({ name }: { name: string }) {
  return (
    <Doc
      label="Site"
      title="Privacy"
      lead={`What this site keeps about visitors, why, and for how long. ${name} runs the site and is responsible for it under UK data protection law (the UK GDPR).`}
    >
      <h2>Reading the site</h2>
      <p>
        The pages are plain files served through Cloudflare. The site adds no analytics, advertising, social media
        or other tracking scripts, and the site itself sets no cookies. The only thing it loads from another
        company is Cloudflare Turnstile, on the home page and only for the contact form (see below).
      </p>
      <p>
        Images come from the site&apos;s own server, which runs on Google Cloud behind Cloudflare. To stop any one
        visitor overloading it, the server counts requests from each address for one minute. It keeps only a keyed
        hash of the address, never the address itself, and the count is deleted after that minute.
      </p>
      <p>
        Like every web host, Cloudflare and Google Cloud handle your IP address and browser details to deliver pages
        and to protect the site from attacks, and keep short request logs for that purpose. How long they keep them
        is set by those companies.
      </p>

      <h2>What is kept in your browser</h2>
      <p>
        If you choose a colour palette or a light or dark theme, your choice is saved in your browser&apos;s local
        storage (under the names <code>palette</code> and <code>theme</code>) so the site looks the same next time.
        If the site is set to show a different palette on each visit, it saves the last palette shown
        (<code>palette-last</code>) and marks the current visit in session storage (<code>palette-visit</code>),
        which your browser clears when you close the tab.
      </p>
      <p>
        These values never leave your browser: the site does not read them on its servers. You can delete them at
        any time by clearing this site&apos;s data in your browser settings.
      </p>

      <h2>Contact form</h2>
      <p>
        The home page has a contact form. If you send a message, the site keeps the name and email address you
        typed, your message, the reason if you chose one, and the time. The email address is not checked, and
        nothing is sent to it. The message is kept so that {name} can read it and reply from an ordinary email program.
        It is shown only in the private editing area, as plain text, and is not shared.
      </p>
      <p>
        <strong>How long.</strong> Messages are kept for 12 months by default. A message is kept for longer only if
        {name} marks it to be kept or has written notes on it, and then until it is deleted. {name} can change the
        periods, and can delete a message at any time. Deleting is a deliberate step that needs a passkey and waits
        24 hours before it runs.
      </p>
      <p>
        <strong>Checks against abuse.</strong> The form uses Cloudflare Turnstile to tell people from automated
        scripts. Its script and frame load from challenges.cloudflare.com on the home page only, and only when you get
        near the form or use it, so reading the site does not load them. Cloudflare receives your browser details
        for the check and handles them under its own privacy policy. When you send a message, the server sends
        Cloudflare the check&apos;s result token to confirm it, and not your message. The form also has a hidden
        field that only scripts fill in, and counts how long it was open.
      </p>
      <p>
        <strong>Your address.</strong> To limit abuse, the server limits each address to 5 messages an hour, each
        email address to 3 a day, and the whole form to 25 a day. It counts them using a keyed hash of your IP
        address and of your email address. A hash cannot be turned back into the address without a secret key kept on
        the server. A hash of your IP address is also kept with your message, and the counts are deleted after an
        hour or a day.
      </p>
      <p>
        <strong>Messages held back.</strong> A message that fails the checks (the hidden field filled in, sent faster
        than a person could, too many links, or an exact repeat) is not thrown away, in case a person was caught by
        mistake. It is kept in a separate folder that {name} reviews, and deleted after 30 days unless it is moved
        to the inbox. You are told your message was received either way.
      </p>
      <p>
        <strong>Without JavaScript.</strong> The form needs JavaScript. If it is switched off, the page says so and
        points to the professional links instead. No email address is shown on this site.
      </p>

      <h2>CV download</h2>
      <p>
        The CV download is not available yet. Before it goes live, this notice will say what it keeps, why, for how
        long, and how to have it deleted.
      </p>

      <h2>Your rights</h2>
      <p>
        You can ask what is held about you, ask for it to be corrected or deleted, or object to how it is used.
        To ask, send a message through the contact form on the home page, saying what you want and which email
        address you used, or use one of the professional profiles linked there. If you are not happy with the answer, you can complain to the Information Commissioner&apos;s Office at{" "}
        <External href="https://ico.org.uk/make-a-complaint/">ico.org.uk</External>.
      </p>
    </Doc>
  );
}

export function AccessibilityPage() {
  return (
    <Doc
      label="Site"
      title="Accessibility"
      lead="This site aims to meet the Web Content Accessibility Guidelines (WCAG) 2.2 at level AA. This page says how, what is known not to work yet, and how to report a problem."
    >
      <h2>What the site does</h2>
      <ul>
        <li>Every page can be read in full with JavaScript turned off. The contact form is the one thing that
          needs it: without it the page says so and points to the professional links.</li>
        <li>
          The contact form has a label on every field, problems written next to the field they belong to (not
          shown by colour alone), results read out by screen readers, and focus moved to the first problem or to
          the confirmation. The anti-spam check is invisible and asks you to do nothing.
        </li>
        <li>
          Everything can be used with a keyboard. A skip link leads to the main content, and focus is always visible.
        </li>
        <li>Pages use one main heading, headings in order, and named regions, so screen readers can move around.</li>
        <li>
          Motion stops when your device asks for reduced motion. The moving skills strip has a pause button and
          starts paused under reduced motion.
        </li>
        <li>
          Every colour palette, in light and dark, is checked for text contrast before it can be saved. Windows
          high contrast mode keeps borders and focus visible.
        </li>
        <li>Text can be enlarged to 200%, and pages work on screens as narrow as 320 pixels with no sideways scrolling.</li>
      </ul>

      <h2>How it is checked</h2>
      <p>
        Every change runs automated checks (axe) on the public pages in light and dark themes. A wider set of
        browser tests covers Chromium, Firefox and WebKit at screen widths from 320 to 1920 pixels, with and without
        reduced motion and JavaScript.
      </p>

      <h2>Known gaps</h2>
      <ul>
        <li>
          Automated checks find only some problems. Hand testing with a screen reader (NVDA), at 200% zoom and on a
          real phone has not been done yet; it is planned before the site launches.
        </li>
        <li>Project images and their descriptions are added by hand, so a missing or weak description is possible.</li>
      </ul>

      <h2>Reporting a problem</h2>
      <p>
        If something on this site is hard to use, please say what page it was and what happened. You can use the
        contact form on the home page or one of the professional profiles linked there.
      </p>
    </Doc>
  );
}

export function SecurityPage() {
  return (
    <Doc
      label="Site"
      title="Security"
      lead="How this site is protected, and how to report a security problem. The design is public on purpose: nothing depends on it staying secret."
    >
      <h2>Reporting a problem</h2>
      <p>
        Please report a suspected vulnerability privately through GitHub:{" "}
        <External href={REPORT_URL}>report a vulnerability</External> on the site&apos;s repository. Do not open a
        public issue. Include the page or file, the steps to reproduce, and what you expected. You should get a reply
        within seven days.
      </p>
      <p>
        Please do not run automated scanners or load tests against the live site. The same details are in{" "}
        <a href="/.well-known/security.txt">security.txt</a>.
      </p>

      <h2>How the site is protected</h2>
      <ul>
        <li>
          Public pages are plain files with a strict content security policy: the only inline script is one small
          script allowed by its hash.
        </li>
        <li>There are no visitor accounts and no cookies on the public site.</li>
        <li>
          The contact form is protected by Cloudflare Turnstile, which loads on the home page only (from
          challenges.cloudflare.com, when you get near the form), a hidden field that only scripts fill in, and
          limits on messages per address, per email address and per day. The server checks the Turnstile result
          itself and refuses every message if it cannot. No other page may load Turnstile, and no page may run
          other people&apos;s scripts.
        </li>
        <li>
          Messages are kept as plain text, checked for length and for characters that could change an email
          header, and never shown as HTML.
        </li>
        <li>
          The editing area is behind Cloudflare Access and a passkey. Important changes also need a fresh passkey
          check and a waiting period.
        </li>
        <li>
          The server refuses requests by default, checks every input against a strict shape, and never shows error
          details.
        </li>
        <li>Uploaded images are redrawn from their pixels, so nothing hidden in the file and no camera details survive.</li>
        <li>Dependencies are pinned and checked on every change.</li>
      </ul>

      <h2>Read more</h2>
      <p>
        The threat model, the OWASP Top 10 map and the design decisions are in the{" "}
        <External href={REPOSITORY}>public repository</External>.
      </p>
    </Doc>
  );
}

export function HowBuiltPage() {
  return (
    <Doc
      label="Site"
      title="How this site is built"
      lead="The parts of this site, where each one runs, and how a change reaches the page you are reading."
    >
      <h2>The parts</h2>
      <ul>
        <li>
          <strong>Public pages:</strong> Next.js and TypeScript, built ahead of time into plain files and served by
          Cloudflare Pages. Nothing runs on a server when you load a page.
        </li>
        <li>
          <strong>Server:</strong> Python with Django REST Framework, in a container on Google Cloud Run behind
          Cloudflare. It holds the content and serves images.
        </li>
        <li>
          <strong>Data:</strong> Postgres on Neon for content, and Redis for rate limits.
        </li>
        <li>
          <strong>Editing:</strong> a private area of the same site, behind Cloudflare Access and a passkey. There is
          no Django admin.
        </li>
      </ul>

      <h2>How a change goes live</h2>
      <ol>
        <li>The owner edits a draft in the editing area. Visitors see nothing yet.</li>
        <li>
          Publish saves a numbered version that can be restored, clears the cached content at Cloudflare, and asks
          Cloudflare Pages to rebuild the site.
        </li>
        <li>
          The rebuild reads the published content once and writes every page as a file. If the build fails, the last
          good version stays live.
        </li>
      </ol>

      <h2>How it is checked</h2>
      <p>
        Every change goes through a pull request. Checks run lint, type checks, unit and server tests, browser tests
        with accessibility checks, a check that each page loads at most 150 kB of JavaScript, and
        dependency audits. Nothing is deployed until they pass.
      </p>

      <h2>Source</h2>
      <p>
        The code is public: <External href={REPOSITORY}>github.com/PjnSai/Portfolio</External>.
      </p>
    </Doc>
  );
}
