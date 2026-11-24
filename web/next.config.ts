import type { NextConfig } from "next";
import { apiOrigin } from "./lib/api-base";
import { siteKeyFrom } from "./lib/public/turnstile-key";
import { siteOrigin } from "./lib/seo";

// Fails the build at once, with the reason, if SITE_ORIGIN is missing on Pages
// or is not a plain origin.
siteOrigin(process.env);

// A static export for Cloudflare Pages: no server, no middleware, no route
// handlers. scripts/check-export.ts fails the build if any server output appears.
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_API_BASE_URL: apiOrigin(process.env.API_BASE_URL),
    NEXT_PUBLIC_TURNSTILE_SITE_KEY: siteKeyFrom(process.env),
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
