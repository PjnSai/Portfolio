import { API_ORIGIN } from "@/lib/api-base";
import { SITE_KEY } from "@/lib/public/turnstile-key";
import { CvLoader } from "./CvLoader";

/**
 * The CV block needs the API to ask what is on and Turnstile to check a visitor,
 * so a build without either has none. Whether anything shows is decided in the
 * browser from the API's status, so a switch changes the site within a minute
 * and no build is needed.
 */
export function cvBlockAvailable(origin: string, key: string): boolean {
  return origin !== "" && key !== "";
}

/**
 * Empty markup that CvLoader fills when the visitor is near it. With the status
 * off, or without JavaScript, there is nothing here and no word about a CV.
 */
export function CvBlock({ available = cvBlockAvailable(API_ORIGIN, SITE_KEY) }: { available?: boolean }) {
  if (!available) return null;
  return (
    <div className="cv-block" data-cv-block>
      <div data-cv-root />
      <CvLoader />
    </div>
  );
}
