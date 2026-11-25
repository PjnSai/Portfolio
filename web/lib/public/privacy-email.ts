// The address for data requests (information or deletion), shown on the
// Privacy page. It is public: it goes into the built page. Set
// NEXT_PUBLIC_PRIVACY_EMAIL for the build. Unset means empty, and the page says
// the address will be added before the site launches. An invalid value fails
// the build at once rather than publish a broken address. No address is
// written into the code.

const ADDRESS = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function privacyEmailFrom(env: Record<string, string | undefined>): string {
  const given = env.NEXT_PUBLIC_PRIVACY_EMAIL?.trim();
  if (!given) return "";
  if (given.length > 254 || !ADDRESS.test(given)) {
    throw new Error("NEXT_PUBLIC_PRIVACY_EMAIL is not a plain email address.");
  }
  return given;
}

/** Inlined by next.config at build time. */
export const PRIVACY_EMAIL = process.env.NEXT_PUBLIC_PRIVACY_EMAIL ?? "";
