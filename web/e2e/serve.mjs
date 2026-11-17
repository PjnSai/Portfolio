// Serves the standalone build with its static files beside it, laid out as in
// the Docker image (see Dockerfile).
import { cpSync } from "node:fs";

cpSync(".next/static", ".next/standalone/.next/static", { recursive: true });
await import("../.next/standalone/server.js");
