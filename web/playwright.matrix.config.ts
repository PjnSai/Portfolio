import { defineConfig, devices, type Project } from "@playwright/test";
import e2e from "./playwright.config";

// The responsive and browser matrix (SPEC 12.1): `npm run test:matrix`.
// One build and one pair of servers serve every project, the same ones the
// e2e run uses (playwright.config.ts). MATRIX_SKIP_BUILD=1 serves the build
// already in out/ (for example straight after `npm run e2e`) and starts the API.
// MATRIX_BROWSERS=chromium,firefox limits the browsers.

export type Combo = {
  browser: "chromium" | "firefox" | "webkit";
  width: number;
  scheme: "light" | "dark";
  motion: "reduce" | "no-preference";
  js: boolean;
};

const DEVICES = {
  chromium: devices["Desktop Chrome"],
  firefox: devices["Desktop Firefox"],
  webkit: devices["Desktop Safari"],
} as const;
const WIDTHS = [320, 390, 768, 1024, 1280, 1920];
/** Every scheme and motion pair at a phone and a laptop width; elsewhere two
    pairs that between them cover both values of each. */
const EVERY_PAIR = new Set([390, 1280]);
const heightFor = (width: number) => (width < 760 ? 740 : width < 1280 ? 900 : 1080);

const browsers = (process.env.MATRIX_BROWSERS ?? "chromium,firefox,webkit")
  .split(",")
  .map((name) => name.trim())
  .filter((name): name is Combo["browser"] => name in DEVICES);

function combos(): Combo[] {
  const found: Combo[] = [];
  for (const browser of browsers) {
    for (const width of WIDTHS) {
      const pairs: [Combo["scheme"], Combo["motion"]][] = EVERY_PAIR.has(width)
        ? [
            ["light", "no-preference"],
            ["dark", "reduce"],
            ["light", "reduce"],
            ["dark", "no-preference"],
          ]
        : [
            ["light", "no-preference"],
            ["dark", "reduce"],
          ];
      for (const [scheme, motion] of pairs) found.push({ browser, width, scheme, motion, js: true });
    }
    for (const width of [320, 1280]) found.push({ browser, width, scheme: "light", motion: "no-preference", js: false });
  }
  return found;
}

const projects: Project[] = combos().map((combo) => ({
  name: `${combo.browser} ${combo.width} ${combo.js ? `${combo.scheme} ${combo.motion === "reduce" ? "reduced" : "motion"}` : "no-js"}`,
  metadata: combo,
  use: {
    ...DEVICES[combo.browser],
    viewport: { width: combo.width, height: heightFor(combo.width) },
    colorScheme: combo.scheme,
    reducedMotion: combo.motion,
    javaScriptEnabled: combo.js,
  },
}));

const [api, site] = e2e.webServer as NonNullable<Extract<typeof e2e.webServer, unknown[]>>;
const skipBuild = process.env.MATRIX_SKIP_BUILD === "1";

export default defineConfig({
  ...e2e,
  testDir: "matrix",
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "github" : [["dot"], ["json", { outputFile: "test-results/matrix.json" }]],
  projects,
  // The API runs in both cases: the owner's inbox pages read from it.
  webServer: skipBuild ? [api, { ...site, command: "npm start", timeout: 30_000 }] : [api, site],
});
