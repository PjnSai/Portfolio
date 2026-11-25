"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ADMIN, useAdmin } from "@/components/admin/AdminApp";
import {
  ContactFields,
  ContactFilterForm,
  ContactIdentity,
  ContactRows,
  LinkableMessages,
  LinkedMessages,
} from "@/components/admin/contacts/ContactViews";
import { EraseEverything } from "@/components/admin/inbox/EraseEverything";
import { Button, Notice, PageTitle } from "@/components/admin/ui";
import { api, ApiError, describeError } from "@/lib/admin/api";
import {
  checkContact,
  type ContactDetail,
  type ContactErrors,
  type ContactFilters,
  type ContactForm,
  contactFiltersFrom,
  contactPageFrom,
  contactsApi,
  contactsHref,
  formFrom,
} from "@/lib/admin/contacts";
import { inboxApi } from "@/lib/admin/inbox";
import { useLoaded } from "@/lib/admin/use-loaded";

// One static page; the contact, the filters and the page number come from the
// query string, because contacts exist only after the site is built.
const ID = /^[0-9a-f-]{36}$/;
const BASE = `${ADMIN}/contacts`;
const MESSAGES = `${ADMIN}/messages`;
const contacts = contactsApi(api);
const inbox = inboxApi(api);

export default function ContactsPage() {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <FromQuery />
    </Suspense>
  );
}

function FromQuery() {
  const params = useSearchParams();
  const id = params.get("id");
  const page = contactPageFrom(params.get("page"));
  const filters = contactFiltersFrom((name) => params.get(name));
  const notice = params.get("notice");
  if (id !== null) {
    return ID.test(id) ? (
      <Detail key={id} id={id} page={page} filters={filters} />
    ) : (
      <ListScreen page={page} filters={filters} notice="" missing />
    );
  }
  return (
    <ListScreen
      page={page}
      filters={filters}
      notice={notice === "deleted" ? "Contact deleted. Its messages were kept." : ""}
    />
  );
}

function ListScreen({
  page,
  filters,
  notice,
  missing = false,
}: {
  page: number;
  filters: ContactFilters;
  notice: string;
  missing?: boolean;
}) {
  const router = useRouter();
  const filterKey = JSON.stringify(filters);
  const fetcher = useCallback(
    () => contacts.list(page, JSON.parse(filterKey) as ContactFilters),
    [page, filterKey],
  );
  const { data: listing, error: loadError } = useLoaded(fetcher);
  const heading = useRef<HTMLHeadingElement>(null);
  const [done, setDone] = useState(notice);

  useEffect(() => {
    if (!notice) return;
    heading.current?.focus();
    router.replace(contactsHref(BASE, page, filters));
  }, [notice, router, page, filters]);

  const shownPage = listing?.page;
  const first = useRef(true);
  useEffect(() => {
    if (shownPage === undefined) return;
    if (first.current) {
      first.current = false;
      return;
    }
    heading.current?.focus();
    setDone(`Page ${shownPage}.`);
  }, [shownPage]);

  return (
    <>
      <PageTitle>Contacts</PageTitle>
      <p className="mb-6 text-muted">
        Senders you chose to keep a record of. They are private and kept until
        you delete them.
      </p>
      <Notice kind="done">{done}</Notice>
      <Notice kind="error">
        {missing
          ? "That contact does not exist."
          : loadError
            ? describeError(loadError)
            : ""}
      </Notice>
      <ContactFilterForm
        key={filterKey}
        filters={filters}
        onApply={(next) => router.push(contactsHref(BASE, 1, next))}
      />
      <h2
        ref={heading}
        tabIndex={-1}
        id="contacts-title"
        className="mb-4 text-xl font-bold"
      >
        {listing
          ? `${listing.count} ${listing.count === 1 ? "contact" : "contacts"}`
          : "Contacts"}
        {listing && listing.pages > 1
          ? `, page ${listing.page} of ${listing.pages}`
          : ""}
      </h2>
      {listing === null ? (
        <p className="text-muted">Loading…</p>
      ) : (
        <ContactRows
          base={BASE}
          listing={listing}
          filters={filters}
          onPage={(next) => router.push(contactsHref(BASE, next, filters))}
        />
      )}
    </>
  );
}

function Detail({
  id,
  page,
  filters,
}: {
  id: string;
  page: number;
  filters: ContactFilters;
}) {
  const router = useRouter();
  const { vital } = useAdmin();
  const fetcher = useCallback(() => contacts.open(id), [id]);
  const { data: loaded, error: loadError } = useLoaded(fetcher);
  const [changed, setChanged] = useState<ContactDetail | null>(null);
  const [gone, setGone] = useState(false);
  const contact = gone ? null : (changed ?? loaded);
  const [form, setForm] = useState<ContactForm | null>(null);
  const [errors, setErrors] = useState<ContactErrors>({});
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [done, setDone] = useState("");
  const [error, setError] = useState("");
  const heading = useRef<HTMLHeadingElement>(null);
  const back = contactsHref(BASE, page, filters);

  const shown = form ?? formFrom(contact);

  async function run<T>(call: () => Promise<T>, then: (result: T) => void) {
    setBusy(true);
    setError("");
    setDone("");
    try {
      then(await call());
    } catch (failure) {
      setError(describeError(failure));
      if (failure instanceof ApiError && failure.status === 404) setGone(true);
    } finally {
      setBusy(false);
    }
  }

  function apply(updated: ContactDetail, say: string) {
    setChanged(updated);
    setForm(null);
    setDone(say);
    heading.current?.focus();
  }

  function save(event: React.FormEvent) {
    event.preventDefault();
    const checked = checkContact(shown);
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length) return;
    return run(
      () => contacts.edit(id, checked.fields),
      (updated) => apply(updated, "Contact saved."),
    );
  }

  if (!contact) {
    return (
      <>
        <PageTitle>Contacts</PageTitle>
        <Notice kind="error">
          {error || (loadError ? describeError(loadError) : "")}
        </Notice>
        {loadError || error ? (
          <p>
            <a href={back} className="underline underline-offset-4">
              Back to contacts
            </a>
          </p>
        ) : (
          <p className="text-muted">Loading…</p>
        )}
      </>
    );
  }

  return (
    <>
      <p className="mb-4">
        <a href={back} className="underline underline-offset-4">
          Back to contacts
        </a>
      </p>
      <h1
        id="contact-title"
        ref={heading}
        tabIndex={-1}
        className="mb-6 text-3xl font-extrabold tracking-tight [overflow-wrap:anywhere]"
      >
        {contact.name}
      </h1>
      <Notice kind="done">{done}</Notice>
      <Notice kind="error">{error}</Notice>
      <ContactIdentity contact={contact} />
      <form
        onSubmit={save}
        noValidate
        aria-label="Edit contact"
        className="mb-10 space-y-4"
      >
        <ContactFields
          prefix="contact"
          form={shown}
          errors={errors}
          onChange={(name, value) => {
            setForm({ ...shown, [name]: value });
            setErrors({ ...errors, [name]: undefined });
          }}
        />
        <Button type="submit" variant="primary" disabled={busy}>
          Save contact
        </Button>
      </form>

      <section aria-labelledby="linked-title" className="mb-10">
        <h2 id="linked-title" className="mb-4 text-xl font-bold">
          Linked messages
        </h2>
        <LinkedMessages
          messageBase={MESSAGES}
          messages={contact.messages}
          busy={busy}
          onUnlink={(message) =>
            run(
              () => contacts.unlink(id, message),
              (updated) => apply(updated, "Message unlinked. It stays in the inbox."),
            )
          }
        />
      </section>

      <Linkable
        contact={contact}
        busy={busy}
        onLink={(message) =>
          run(
            () => contacts.link(id, message),
            (updated) => apply(updated, "Message linked. It is kept while it is linked."),
          )
        }
      />

      <section aria-labelledby="remove-title" className="space-y-4 border-t-2 border-ink pt-8">
        <h2 id="remove-title" className="text-xl font-bold">
          Remove
        </h2>
        {confirming ? (
          <div className="space-y-3">
            <p>
              Delete this contact? Its messages stay in the inbox. This asks for
              your passkey.
            </p>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="danger"
                disabled={busy}
                onClick={() =>
                  run(
                    () => vital(() => contacts.remove(id)),
                    () => router.push(`${BASE}?notice=deleted`),
                  )
                }
              >
                Delete this contact
              </Button>
              <Button disabled={busy} onClick={() => setConfirming(false)}>
                Keep it
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="danger" onClick={() => setConfirming(true)}>
            Delete this contact
          </Button>
        )}
      </section>
      <EraseEverything from={{ contact: id }} />
    </>
  );
}

/** Messages from the same sender that are not linked to any contact yet. */
function Linkable({
  contact,
  busy,
  onLink,
}: {
  contact: ContactDetail;
  busy: boolean;
  onLink: (id: string) => void;
}) {
  const email = contact.email.toLowerCase();
  const linkedKey = contact.messages.map((message) => message.id).join(",");
  const fetcher = useCallback(
    () => inbox.list("inbox", 1, { q: email, reason: "", since: "", until: "" }),
    // Look again when the linked messages change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [email, linkedKey],
  );
  const { data } = useLoaded(fetcher);
  const messages = useMemo(
    () =>
      data
        ? data.results.filter(
            (message) => message.contact_id === null && message.email.toLowerCase() === email,
          )
        : null,
    [data, email],
  );
  return (
    <section aria-labelledby="linkable-title" className="mb-10">
      <h2 id="linkable-title" className="mb-4 text-xl font-bold">
        Link another message from this sender
      </h2>
      <LinkableMessages
        messageBase={MESSAGES}
        messages={messages}
        busy={busy}
        onLink={onLink}
      />
    </section>
  );
}
