import { defineConfig, devices } from "@playwright/test";

const port = 3100;
const apiPort = 8100;

// The admin tests need the API too. It is started by api/tests/e2e_server.py
// with a fresh database (see that file); E2E_PYTHON picks the interpreter.
// The site is then built against it, as Pages builds it, and served with its
// _headers by scripts/serve-static.ts. Site and API are different origins on
// one site (localhost), as in production.
export default defineConfig({
  testDir: "e2e",
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? "github" : "list",
  // WebAuthn needs a secure context and a domain name, so not 127.0.0.1.
  use: { baseURL: `http://localhost:${port}` },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: `${process.env.E2E_PYTHON ?? "python"} tests/e2e_server.py`,
      cwd: "../api",
      env: {
        E2E_SITE_ORIGIN: `http://localhost:${port}`,
        E2E_API_PORT: String(apiPort),
      },
      url: `http://127.0.0.1:${apiPort}/healthz`,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: "npm run build && npm start",
      env: {
        PORT: String(port),
        HOSTNAME: "localhost",
        API_BASE_URL: `http://localhost:${apiPort}`,
        SITE_ORIGIN: `http://localhost:${port}`,
      },
      url: `http://localhost:${port}/`,
      reuseExistingServer: !process.env.CI,
      timeout: 300_000,
    },
  ],
});
