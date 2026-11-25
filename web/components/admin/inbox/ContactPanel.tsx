"use client";

import Link from "next/link";
import { useState } from "react";
import { ContactFields } from "@/components/admin/contacts/ContactViews";
import { Button, Notice } from "@/components/admin/ui";
import { api, describeError } from "@/lib/admin/api";
import {
  checkContact,
  type ContactErrors,
  type ContactForm,
  contactHref,
  contactsApi,
  formFrom,
} from "@/lib/admin/contacts";
import type { MessageDetail } from "@/lib/admin/inbox";

const contacts = contactsApi(api);

/** What the message page shows about the sender's saved contact. */
export function ContactPanelView({
  message,
  contactsBase,
  open,
  form,
  errors,
  busy,
  error,
  onOpen,
  onClose,
  onChange,
  onSubmit,
}: {
  message: MessageDetail;
  contactsBase: string;
  open: boolean;
  form: ContactForm;
  errors: ContactErrors;
  busy: boolean;
  error: string;
  onOpen: () => void;
  onClose: () => void;
  onChange: (name: keyof ContactForm, value: string) => void;
  onSubmit: (event: React.FormEvent) => void;
}) {
  return (
    <section aria-labelledby="contact-panel-title" className="mt-8 space-y-3">
      <h2 id="contact-panel-title" className="text-xl font-bold">
        Saved contact
      </h2>
      {message.contact_id ? (
        <p>
          This sender is a saved contact.{" "}
          <Link
            href={contactHref(contactsBase, message.contact_id)}
            className="underline underline-offset-4"
          >
            Open the contact
          </Link>
        </p>
      ) : open ? (
        <form
          onSubmit={onSubmit}
          noValidate
          aria-label="Save as contact"
          className="space-y-4 rounded-lg border border-line bg-panel p-4"
        >
          <p className="text-sm text-muted">
            The name and email are copied from this message. Everything else is
            optional, private, and kept until you delete the contact.
          </p>
          <ContactFields
            prefix="new-contact"
            form={form}
            errors={errors}
            onChange={onChange}
          />
          <Notice kind="error">{error}</Notice>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" variant="primary" disabled={busy}>
              Save contact
            </Button>
            <Button disabled={busy} onClick={onClose}>
              Not now
            </Button>
          </div>
        </form>
      ) : (
        <>
          <p className="text-sm text-muted">
            Keep a record of this sender, with notes and a follow-up date.
          </p>
          <Button id="save-as-contact" onClick={onOpen}>
            Save as contact
          </Button>
          <Notice kind="error">{error}</Notice>
        </>
      )}
    </section>
  );
}

export function ContactPanel({
  message,
  contactsBase,
  onSaved,
}: {
  message: MessageDetail;
  contactsBase: string;
  onSaved: (contactId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<ContactForm>(formFrom(null));
  const [errors, setErrors] = useState<ContactErrors>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const checked = checkContact(form);
    setErrors(checked.errors);
    if (Object.keys(checked.errors).length) return;
    setBusy(true);
    setError("");
    try {
      const created = await contacts.createFromMessage(message.id, checked.fields);
      setOpen(false);
      onSaved(created.id);
    } catch (failure) {
      setError(describeError(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ContactPanelView
      message={message}
      contactsBase={contactsBase}
      open={open}
      form={form}
      errors={errors}
      busy={busy}
      error={error}
      onOpen={() => setOpen(true)}
      onClose={() => {
        setOpen(false);
        setError("");
      }}
      onChange={(name, value) => {
        setForm({ ...form, [name]: value });
        setErrors({ ...errors, [name]: undefined });
      }}
      onSubmit={submit}
    />
  );
}
