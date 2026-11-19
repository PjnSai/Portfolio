import type { MetadataRoute } from "next";
import { absoluteUrl, BLOCKED_AGENTS } from "@/lib/seo";

export const dynamic = "force-static";

// SPEC 8.5: search engines are welcome; the agents in BLOCKED_AGENTS are not.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: [...BLOCKED_AGENTS], disallow: "/" },
      { userAgent: "*", allow: "/" },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
