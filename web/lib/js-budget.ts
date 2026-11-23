// Initial JavaScript on a page: the scripts its HTML loads at first paint
// (not the legacy nomodule copy) plus its inline scripts, gzipped.
// Relative imports only: the build scripts load this file with Node directly.

import { gzipSync } from "node:zlib";

/** The budget in SPEC 4.6, in kB of 1,000 bytes. */
export const INITIAL_JS_BUDGET_KB = 150;

const EXTERNAL = /<script\b[^>]*\ssrc="([^"]+)"[^>]*>/gi;
const INLINE = /<script\b(?![^>]*\ssrc=)([^>]*)>([\s\S]*?)<\/script>/gi;
const DATA_TYPE = /\stype="(?!(?:text\/javascript|module)")[^"]*"/i;

export function initialScripts(html: string): { sources: string[]; inline: string[] } {
  const sources = new Set<string>();
  for (const match of html.matchAll(EXTERNAL)) {
    if (/\snomodule/i.test(match[0])) continue;
    sources.add(match[1]);
  }
  const inline: string[] = [];
  for (const match of html.matchAll(INLINE)) {
    if (DATA_TYPE.test(match[1]) || match[2] === "") continue;
    inline.push(match[2]);
  }
  return { sources: [...sources], inline };
}

export const gzipBytes = (text: string | Buffer) => gzipSync(text).length;

/** Gzipped bytes of the page's initial JavaScript; `read` returns a script's file. */
export function initialJsBytes(html: string, read: (src: string) => Buffer): number {
  const { sources, inline } = initialScripts(html);
  const external = sources.reduce((total, src) => total + gzipBytes(read(src)), 0);
  return external + (inline.length ? gzipBytes(inline.join("\n")) : 0);
}
