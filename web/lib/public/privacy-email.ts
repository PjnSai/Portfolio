// The address for data requests (information or deletion), shown on the
// Privacy page. It is public: it goes into the built page. Set
// NEXT_PUBLIC_PRIVACY_EMAIL for the build. A local build without one has it
// empty, and the page says the address will be added before the site launches.
// A Cloudflare Pages build without one fails, as does an invalid value, rather
// than publish a page with no address or a broken one. No address is written
// into the code.

const ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function privacyEmailFrom(env: Record<string, string | undefined>): string {
  const given = env.NEXT_PUBLIC_PRIVACY_EMAIL?.trim();
  if (!given) {
    if (env.CF_PAGES) throw new Error("NEXT_PUBLIC_PRIVACY_EMAIL is not set for a Pages build.");
    return "";
  }
  if (given.length > 254 || !ADDRESS.test(given)) {
    throw new Error("NEXT_PUBLIC_PRIVACY_EMAIL is not a plain email address.");
  }
  return given;
}

/** Inlined by next.config at build time. */
export const PRIVACY_EMAIL = process.env.NEXT_PUBLIC_PRIVACY_EMAIL ?? "";
