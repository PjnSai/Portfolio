// Runs after `next build`: writes out/.well-known/security.txt with this
// site's address and an expiry date moved on by each build.
import { mkdirSync, writeFileSync } from "node:fs";
import { securityTxt, siteOrigin } from "../lib/seo.ts";

mkdirSync("out/.well-known", { recursive: true });
writeFileSync("out/.well-known/security.txt", securityTxt(siteOrigin(process.env)));
console.log("security.txt written");
