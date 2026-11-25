import type { ReactNode } from "react";
import { type CvStatus, cvShown, updatedText } from "@/lib/public/cv";

// The CV block's markup. It shows nothing at all unless a button or the form
// would show, so a CV that is switched off leaves no trace on the page.

export const SECTION_IDS = {
  section: "cv",
  view: "cv-view",
  status: "cv-status",
} as const;

export type CvSectionProps = {
  status: CvStatus | null;
  /** False until the code has taken over; the buttons are off until then. */
  ready?: boolean;
  /** What the live region says: progress or a problem with the check. */
  note?: string;
  busy?: boolean;
  onView?: () => void;
  /** The request form, when requests are on. */
  request?: ReactNode;
  /** Where Turnstile's widget is drawn. */
  turnstile?: ReactNode;
};

export function CvSectionView({
  status,
  ready = true,
  note = "",
  busy = false,
  onView,
  request,
  turnstile,
}: CvSectionProps) {
  if (!status || !cvShown(status)) return null;
  const date = updatedText(status.updated);
  return (
    <section className="cv" id={SECTION_IDS.section} aria-labelledby="cv-title">
      <h3 id="cv-title" className="cv__title">
        CV
      </h3>
      {date ? <p className="cv__updated">{date}</p> : null}
      {status.canView ? (
        <div className="cv__actions">
          <button
            type="button"
            id={SECTION_IDS.view}
            className="btn btn--fill"
            disabled={!ready || busy}
            aria-describedby={SECTION_IDS.status}
            onClick={onView}
          >
            View the CV
          </button>
        </div>
      ) : null}
      <p id={SECTION_IDS.status} role="status" aria-live="polite" className="cv__status">
        {note}
      </p>
      {request}
      {turnstile}
    </section>
  );
}
