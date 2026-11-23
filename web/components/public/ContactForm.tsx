import type { FormEvent } from "react";
import {
  type Errors,
  FIELD_LABEL,
  type FieldName,
  LIMITS,
  REASONS,
  SENT_TEXT,
} from "@/lib/public/contact";

// The contact form's markup. It is a plain component with no state and no
// hooks, so the same markup is written into the page at build time and, when
// the visitor reaches the form, taken over by ContactApp (which fetches this
// file again, in its own chunk). Fields are not controlled: what a visitor
// types before the form's code arrives is kept.

export type FormState = {
  status: "idle" | "sending" | "sent";
  errors: Errors;
  /** What the live region says: progress, a problem, or the outcome. */
  announcement: string;
  /** False until the form's code has taken over; the button is off until then. */
  ready: boolean;
};

export const INITIAL_STATE: FormState = {
  status: "idle",
  errors: {},
  announcement: "",
  ready: false,
};

export const IDS = {
  form: "contact-form",
  status: "contact-status",
  sent: "contact-sent",
} as const;

type Handlers = {
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  onAnother?: () => void;
};

function Field({
  name,
  errors,
  required,
  children,
  hint,
}: {
  name: FieldName;
  errors: Errors;
  required?: boolean;
  children: (props: Record<string, unknown>) => React.ReactNode;
  hint?: string;
}) {
  const id = `contact-${name}`;
  const error = errors[name];
  const described = [hint ? `${id}-hint` : "", `${id}-error`].filter(Boolean).join(" ");
  return (
    <div className="contact-form__field">
      <label htmlFor={id}>
        {FIELD_LABEL[name]}
        {required ? <span className="contact-form__required"> (required)</span> : <span> (optional)</span>}
      </label>
      {children({
        id,
        name,
        "aria-describedby": described,
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}
      {hint ? (
        <p id={`${id}-hint`} className="contact-form__hint">
          {hint}
        </p>
      ) : null}
      <p id={`${id}-error`} className="contact-form__error">
        {error ? <span className="contact-form__error-label">Error: </span> : null}
        {error ?? ""}
      </p>
    </div>
  );
}

export function ContactFormView({
  state = INITIAL_STATE,
  onSubmit,
  onAnother,
}: { state?: FormState } & Handlers) {
  const { errors, status, announcement, ready } = state;

  if (status === "sent") {
    return (
      <div className="contact-sent" id={IDS.sent} tabIndex={-1} data-contact-sent>
        <h3>Message sent</h3>
        <p>{SENT_TEXT}</p>
        <button type="button" className="btn btn--outline" onClick={onAnother}>
          Send another message
        </button>
        <p role="status" aria-live="polite" className="visually-hidden">
          {announcement}
        </p>
      </div>
    );
  }

  return (
    <form
      id={IDS.form}
      className="contact-form"
      noValidate
      aria-labelledby="contact-form-title"
      onSubmit={onSubmit}
    >
      <h3 id="contact-form-title" className="contact-form__title">
        Send a message
      </h3>
      <Field name="name" errors={errors} required>
        {(props) => (
          <input type="text" autoComplete="name" maxLength={LIMITS.name} {...props} />
        )}
      </Field>
      <Field name="email" errors={errors} required hint="I use this only to reply to you. It is not checked.">
        {(props) => (
          <input
            type="email"
            autoComplete="email"
            inputMode="email"
            maxLength={LIMITS.email}
            {...props}
          />
        )}
      </Field>
      <Field name="reason" errors={errors}>
        {(props) => (
          <select defaultValue="" {...props}>
            {REASONS.map((reason) => (
              <option key={reason.value} value={reason.value}>
                {reason.label}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field name="body" errors={errors} required>
        {(props) => <textarea rows={6} maxLength={LIMITS.bodyMax} {...props} />}
      </Field>

      {/* A trap for scripts that fill every field. Not for people: off screen,
          out of the tab order and hidden from screen readers. */}
      <div className="contact-form__trap" aria-hidden="true">
        <label htmlFor="contact-website">Leave this field empty</label>
        <input type="text" id="contact-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <div data-turnstile className="contact-form__turnstile" />

      <button
        type="submit"
        className="btn btn--fill contact-form__send"
        disabled={!ready || status === "sending"}
      >
        {status === "sending" ? "Sending…" : "Send message"}
      </button>
      <p id={IDS.status} role="status" aria-live="polite" className="contact-form__status">
        {announcement}
      </p>
      <p className="contact-form__privacy">
        Your name, email and message are kept so that I can reply. They are not shown to anyone else.
        This form is protected by Cloudflare Turnstile. Read the <a href="/privacy">privacy notice</a>.
      </p>
    </form>
  );
}
