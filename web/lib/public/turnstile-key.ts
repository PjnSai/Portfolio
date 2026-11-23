// The Turnstile site key. It is public: it goes to the visitor's browser. The
// secret key stays on the API. Set TURNSTILE_SITE_KEY for the build; a local
// build without one uses Cloudflare's dummy key for an invisible widget that
// always passes. A Cloudflare Pages build with none has no form: the page says
// so and points to the professional links, because a form that cannot check
// anyone must not be shown.

export const DUMMY_INVISIBLE_KEY = "1x00000000000000000000BB";

const SHAPE = /^[0-9A-Za-z_-]{16,64}$/;

export function siteKeyFrom(env: Record<string, string | undefined>): string {
  const given = env.TURNSTILE_SITE_KEY;
  if (given) {
    if (!SHAPE.test(given)) throw new Error("TURNSTILE_SITE_KEY is not a Turnstile site key.");
    return given;
  }
  return env.CF_PAGES ? "" : DUMMY_INVISIBLE_KEY;
}

/** Inlined by next.config at build time. */
export const SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";
