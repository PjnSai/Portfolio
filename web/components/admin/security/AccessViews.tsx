import Link from "next/link";
import {
  isSession,
  type PasskeyItem,
  type Principal,
  REVOKABLE_IN_APP,
  REVOKE_PATH,
  type SessionItem,
} from "@/lib/admin/access";
import { shortDate } from "@/lib/admin/time";

export function SuperuserWarning() {
  return (
    <div role="alert" className="mb-8 rounded-md border-2 border-danger bg-panel p-4 text-danger">
      <h2 className="mb-1 text-lg font-extrabold">The API is connected to the database as a superuser</h2>
      <p>
        A superuser can read and change everything, so the limits set for the website&apos;s database role do not
        apply. This is expected on a local test database. It must never be the case in production: fix it before
        anything else.
      </p>
    </div>
  );
}

export function AccessNotes() {
  return (
    <div className="mb-8 space-y-3 text-muted">
      <p>
        A quarterly review is the plan: open this page every three months and check that each line is still what you
        expect. The page does not record that you did, and stores nothing.
      </p>
      <p>
        Principals outside the app (the deploy pipeline, the Cloudflare API token and the Access policy, the offline
        recovery key) are described here but cannot be checked by it. docs/ACCESS.md covers each one, how to rotate or
        revoke it, and the steps of the review.
      </p>
    </div>
  );
}

const TERM = "font-mono text-xs uppercase tracking-wide text-muted";

function Facts({ principal }: { principal: Principal }) {
  const unchecked = !principal.checked_by_app;
  const last = principal.last_used
    ? shortDate(principal.last_used)
    : unchecked
      ? "Not known"
      : "never";
  return (
    <dl className="mt-4 grid gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]">
      <dt className={TERM}>Credential</dt>
      <dd className="[overflow-wrap:anywhere]">{principal.credential}</dd>
      <dt className={TERM}>Expiry</dt>
      <dd>
        {principal.expiry}
        {principal.expires ? ` Next ends ${shortDate(principal.expires)}.` : ""}
      </dd>
      <dt className={TERM}>Last used</dt>
      <dd>{last}</dd>
      {principal.configured !== undefined && (
        <>
          <dt className={TERM}>Secret</dt>
          <dd>{principal.configured ? "Set" : "Not set"}</dd>
        </>
      )}
    </dl>
  );
}

function SessionRows({ items }: { items: SessionItem[] }) {
  if (items.length === 0) return <p className="mt-4 text-muted">No signed-in sessions.</p>;
  return (
    <ul className="mt-4 divide-y divide-line rounded-md border border-line" data-testid="sessions">
      {items.map((item, index) => (
        <li key={index} className="p-3 text-sm">
          <strong>{item.current ? "This session" : "Another session"}</strong>
          <span className="block font-mono text-xs text-muted">
            Signed in {shortDate(item.signed_in_at)} · last used {shortDate(item.last_used ?? null)} · ends{" "}
            {shortDate(item.expires)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function PasskeyRows({ items }: { items: PasskeyItem[] }) {
  return (
    <ul className="mt-4 divide-y divide-line rounded-md border border-line" data-testid="passkeys">
      {items.map((item) => (
        <li key={item.id} className="p-3 text-sm">
          <strong>{item.name}</strong>
          <span className="block font-mono text-xs text-muted">
            Added {shortDate(item.created_at)} · last used {shortDate(item.last_used ?? null)}
          </span>
        </li>
      ))}
    </ul>
  );
}

function RevokeLink({ principal }: { principal: Principal }) {
  if (principal.id === "owner_sessions") {
    return (
      <p className="mt-4 text-sm">
        <Link href={REVOKE_PATH} className="font-semibold underline underline-offset-4">
          Sign out everywhere on the Security page
        </Link>{" "}
        ends every session.
      </p>
    );
  }
  return (
    <p className="mt-4 text-sm">
      <Link href={REVOKE_PATH} className="font-semibold underline underline-offset-4">
        Remove a passkey on the Security page
      </Link>
      . Removing one is a vital action, with its 24-hour wait.
    </p>
  );
}

export function PrincipalCard({ principal }: { principal: Principal }) {
  const heading = `access-${principal.id}`;
  const items = principal.items ?? [];
  const sessions = items.filter(isSession);
  const passkeys = items.filter((item): item is PasskeyItem => !isSession(item));
  return (
    <section
      aria-labelledby={heading}
      data-testid="principal"
      data-principal={principal.id}
      className="rounded-lg border border-line bg-panel p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id={heading} className="text-xl font-extrabold">
          {principal.name}
        </h2>
        {!principal.checked_by_app && (
          <span className="rounded-md border border-ink px-2 py-1 font-mono text-xs font-bold uppercase">
            Not checked by the app
          </span>
        )}
      </div>
      {principal.purpose && <p className="mt-1 text-muted">{principal.purpose}</p>}
      {principal.warning && (
        <p role="alert" className="mt-3 rounded-md border-l-4 border-danger bg-paper px-3 py-2 font-semibold text-danger">
          {principal.warning}
        </p>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <h3 className={TERM}>Can</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {principal.can.map((line) => (
              <li key={line} className="[overflow-wrap:anywhere]">
                {line}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h3 className={TERM}>Cannot</h3>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {principal.cannot.map((line) => (
              <li key={line} className="[overflow-wrap:anywhere]">
                {line}
              </li>
            ))}
          </ul>
        </div>
      </div>
      <Facts principal={principal} />
      {principal.note && <p className="mt-3 text-sm text-muted">{principal.note}</p>}
      {principal.id === "owner_sessions" && <SessionRows items={sessions} />}
      {principal.id === "owner_passkeys" && <PasskeyRows items={passkeys} />}
      {REVOKABLE_IN_APP.has(principal.id) ? (
        <RevokeLink principal={principal} />
      ) : (
        <p className="mt-4 text-sm text-muted">Not revoked from this site: see docs/ACCESS.md.</p>
      )}
    </section>
  );
}
