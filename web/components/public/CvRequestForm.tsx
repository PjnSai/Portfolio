import type { FormEvent } from "react";
import { SENT_TEXT } from "@/lib/public/contact";
import {
  CV_NAME_MAX,
  CV_NOTE_MAX,
  LINK_NOTE,
  REQUEST_LABEL,
  type RequestErrors,
  type RequestFieldName,
} from "@/lib/public/cv";

// The copy request form's markup, in the same plain way as the contact form:
// no state and no hooks, fields not controlled, no field named, so a native
// submit before the code arrives sends nothing. The labels are "Your name" and
// "Your email", so they never match the contact form's fields on the same page.
// What the form shows after sending is the same for every answer the API gives;
// only a link in the answer adds the download button.

export type RequestState = {
  status: "idle" | "sending" | "sent";
  errors: RequestErrors;
  announcement: string;
  /** False until the code has taken over; the button is off until then. */
  ready: boolean;
  /** The one-minute download link, if the API's answer carried one. */
  download: string | null;
  /** The minute is up. */
  expired: boolean;
};

export const INITIAL_REQUEST: RequestState = {
  status: "idle",
  errors: {},
  announcement: "",
  ready: false,
  download: null,
  expired: false,
};

export const CV_IDS = {
  wrapper: "cv-request",
  form: "cv-request-form",
  status: "cv-request-status",
  sent: "cv-request-sent",
  website: "cv-request-website",
} as const;

const FIELD_TEXT: Record<RequestFieldName, string> = {
  name: "Your name",
  email: "Your email",
  note: "Note",
};

function Field({
  name,
  errors,
  required,
  hint,
  children,
}: {
  name: RequestFieldName;
  errors: RequestErrors;
  required?: boolean;
  hint?: string;
  children: (props: Record<string, unknown>) => React.ReactNode;
}) {
  const id = `cv-request-${name}`;
  const error = errors[name];
  const described = [hint ? `${id}-hint` : "", `${id}-error`].filter(Boolean).join(" ");
  return (
    <div className="contact-form__field">
      <label htmlFor={id}>
        {FIELD_TEXT[name]}
        {required ? <span className="contact-form__required"> (required)</span> : <span> (optional)</span>}
      </label>
      {children({
        id,
        "aria-describedby": described,
        "aria-invalid": error ? true : undefined,
        "aria-required": required ? true : undefined,
      })}
      {hint ? (
        <p id={`${id}-hint`} className="contact-form__hint">
          {hint}
        </p>
      ) : null}
      <p id={`${id}-error`} className="contact-form__error cv-request__error">
        {error ? <span className="contact-form__error-label">Error: </span> : null}
        {error ?? ""}
      </p>
    </div>
  );
}

export { REQUEST_LABEL };

export const INSTANT_HINT = "After you send this, a link to download the CV appears for a minute.";

export function CvRequestView({
  state = INITIAL_REQUEST,
  instant = false,
  onSubmit,
}: {
  state?: RequestState;
  /** The API says a download link follows a request: tell the visitor. */
  instant?: boolean;
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
}) {
  const { errors, status, announcement, ready, download, expired } = state;

  if (status === "sent") {
    return (
      <div className="contact-sent" id={CV_IDS.sent} tabIndex={-1} data-cv-sent>
        <h4>Request sent</h4>
        <p>{SENT_TEXT}</p>
        {download && !expired ? (
          <a className="btn btn--fill" href={download} rel="noreferrer">
            Download the CV
          </a>
        ) : null}
        {download && !expired ? <p>{LINK_NOTE}</p> : null}
        {download && expired ? <p>The download link has expired.</p> : null}
        <p role="status" aria-live="polite" className="visually-hidden">
          {announcement}
        </p>
      </div>
    );
  }

  return (
    <form
      id={CV_IDS.form}
      className="contact-form"
      method="post"
      noValidate
      aria-labelledby="cv-request-title"
      onSubmit={onSubmit}
    >
      <h4 id="cv-request-title" className="contact-form__title">
        Ask for a copy
      </h4>
      {instant ? <p className="contact-form__hint">{INSTANT_HINT}</p> : null}
      <Field name="name" errors={errors}>
        {(props) => <input type="text" autoComplete="name" maxLength={CV_NAME_MAX} {...props} />}
      </Field>
      <Field name="email" errors={errors} required hint="I use this only to reply to you. It is not checked.">
        {(props) => <input type="email" autoComplete="email" inputMode="email" maxLength={254} {...props} />}
      </Field>
      <Field name="note" errors={errors}>
        {(props) => <textarea rows={3} maxLength={CV_NOTE_MAX} {...props} />}
      </Field>

      {/* A trap for scripts that fill every field. Not for people: off screen,
          out of the tab order and hidden from screen readers. */}
      <div className="contact-form__trap" aria-hidden="true">
        <label htmlFor={CV_IDS.website}>Leave this field empty</label>
        <input type="text" id={CV_IDS.website} tabIndex={-1} autoComplete="off" />
      </div>

      <button
        type="submit"
        className="btn btn--fill contact-form__send"
        disabled={!ready || status === "sending"}
      >
        {status === "sending" ? "Sending…" : "Request a copy"}
      </button>
      <p id={CV_IDS.status} role="status" aria-live="polite" className="contact-form__status cv-request__status">
        {announcement}
      </p>
      <p className="contact-form__privacy">
        Your email and note are kept so that I can reply. They are not shown to anyone else. This form is protected
        by Cloudflare Turnstile. Read the <a href="/privacy">privacy notice</a>.
      </p>
    </form>
  );
}
