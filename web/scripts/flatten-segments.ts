// Runs after `next build`. The static export writes a nested page's prefetch
// file as <route>/__next.desk/sections/__PAGE__.txt, but the client asks for
// <route>/__next.desk.sections.__PAGE__.txt. On a static host the request then
// gets the 404 page and the prefetch never settles. Renaming the files to the
// names the client asks for fixes it without any server-side rewrite.
import { readdirSync, renameSync, rmSync } from "node:fs";
import { join, relative, sep } from "node:path";

const OUT = "out";

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}

function segmentDirs(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || entry.name === "_next") return [];
    const path = join(dir, entry.name);
    return entry.name.startsWith("__next.") ? [path] : segmentDirs(path);
  });
}

let moved = 0;
for (const top of segmentDirs(OUT)) {
  const parent = join(top, "..");
  for (const file of files(top)) {
    const flat = relative(parent, file).split(sep).join(".");
    renameSync(file, join(parent, flat));
    moved += 1;
  }
  rmSync(top, { recursive: true });
}
console.log(`prefetch files renamed: ${moved}`);
