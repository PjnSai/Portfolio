// Runs before `next build`. Next keeps build-time fetch answers in
// .next/cache/fetch-cache and Pages restores .next/cache between builds, so a
// build could reuse an old GET /api/v1/site instead of reading the API.
import { rmSync } from "node:fs";

rmSync(".next/cache/fetch-cache", { recursive: true, force: true });
