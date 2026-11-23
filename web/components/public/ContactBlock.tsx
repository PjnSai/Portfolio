import { API_ORIGIN } from "@/lib/api-base";
import { SITE_KEY } from "@/lib/public/turnstile-key";
import type { PublicSite } from "@/lib/site";
import { ContactFormView } from "./ContactForm";
import { ContactLoader } from "./ContactLoader";

/**
 * The form is offered only when the owner has it switched on, the build knows
 * where to send it (the API) and has a Turnstile site key. Without any of
 * these there is no form, and the page says so rather than showing one that
 * cannot work or cannot check anyone.
 */
export function contactAvailable(site: PublicSite): boolean {
  return site.settings.contact_form !== false && API_ORIGIN !== "" && SITE_KEY !== "";
}

/**
 * The contact form's markup is in the page itself. Without JavaScript only the
 * note shows (the form is hidden until the boot script has run, which sets
 * data-theme on the page); with it, the form is there from the first paint and
 * its code is fetched when the visitor gets near it (ContactLoader).
 */
export function ContactBlock({ site }: { site: PublicSite }) {
  if (!contactAvailable(site)) {
    return (
      <p className="contact-note">
        The contact form is not available at the moment. Please use one of the professional links below.
      </p>
    );
  }
  return (
    <div className="contact" data-contact-form>
      <noscript>
        <p className="contact-note">
          The contact form needs JavaScript, which is switched off in this browser. Please use one of the
          professional links below instead.
        </p>
      </noscript>
      <div className="contact__wrap">
        <div data-contact-root>
          <ContactFormView />
        </div>
        <p className="contact-note" data-contact-failed hidden>
          The form could not be loaded. Please reload the page, or use one of the professional links below.
        </p>
      </div>
      <ContactLoader />
    </div>
  );
}
