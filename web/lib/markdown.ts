// Markdown from the admin, turned into React elements from a short allow-list.
// No HTML string is built and nothing is set through innerHTML: raw HTML in the
// source is shown as text, images become their alt text, and a link is kept
// only if it is https, a site path or an anchor.

import MarkdownIt, { type Token } from "markdown-it";
import { createElement, Fragment, type ReactNode } from "react";

const parser = new MarkdownIt("commonmark", { html: false, linkify: false });

const UNSAFE_CHARACTERS = /[\s\\\u0000-\u001f\u007f]/;
const EXTERNAL_REL = "noopener noreferrer nofollow";

/** The link if it is allowed on the site, otherwise null. */
export function safeHref(raw: string | null | undefined): string | null {
  if (!raw || UNSAFE_CHARACTERS.test(raw)) return null;
  if (raw.startsWith("#")) return raw;
  if (raw.startsWith("/")) return raw.startsWith("//") ? null : raw;
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && url.hostname && !url.username && !url.password) {
      return raw;
    }
  } catch {
    // Not a full address.
  }
  return null;
}

type Opened = { element: string | null; props: Record<string, unknown> };

const SIMPLE: Record<string, string> = {
  paragraph_open: "p",
  bullet_list_open: "ul",
  list_item_open: "li",
  blockquote_open: "blockquote",
  em_open: "em",
  strong_open: "strong",
};

/**
 * Heading levels for the page outline. The source's own levels only say which
 * heading sits under which: the first heading gets `base`, and each heading is
 * at most one level below the one it sits under, so the outline never skips a
 * level. Levels past h6 stay at h6.
 */
export class Outline {
  private readonly open: number[] = [];
  constructor(private readonly base: number) {}

  level(sourceLevel: number): number {
    while (this.open.length && this.open[this.open.length - 1] >= sourceLevel) this.open.pop();
    const level = Math.min(6, this.base + this.open.length);
    this.open.push(sourceLevel);
    return level;
  }
}

function open(token: Token, outline: Outline): Opened {
  if (token.type === "paragraph_open" && token.hidden) return { element: null, props: {} };
  if (token.type in SIMPLE) return { element: SIMPLE[token.type], props: {} };
  if (token.type === "heading_open") {
    return { element: `h${outline.level(Number(token.tag.slice(1)))}`, props: {} };
  }
  if (token.type === "ordered_list_open") {
    const start = Number(token.attrGet("start") ?? 1);
    return { element: "ol", props: start !== 1 ? { start } : {} };
  }
  if (token.type === "link_open") {
    const href = safeHref(String(token.attrGet("href") ?? ""));
    if (href === null) return { element: null, props: {} };
    return {
      element: "a",
      props: href.startsWith("https:") ? { href, rel: EXTERNAL_REL } : { href },
    };
  }
  return { element: null, props: {} };
}

function leaf(token: Token, key: number, outline: Outline): ReactNode {
  switch (token.type) {
    case "inline":
    case "image":
      return createElement(Fragment, { key }, ...build(token.children ?? [], outline));
    case "text":
      return token.content;
    case "softbreak":
      return "\n";
    case "hardbreak":
      return createElement("br", { key });
    case "code_inline":
      return createElement("code", { key }, token.content);
    case "code_block":
    case "fence":
      return createElement("pre", { key }, createElement("code", null, token.content));
    case "hr":
      return createElement("hr", { key });
    default:
      return token.content;
  }
}

function build(tokens: Token[], outline: Outline): ReactNode[] {
  const root: ReactNode[] = [];
  const stack: (Opened & { children: ReactNode[] })[] = [];
  const current = () => (stack.length ? stack[stack.length - 1].children : root);
  let key = 0;
  for (const token of tokens) {
    if (token.nesting === 1) {
      stack.push({ ...open(token, outline), children: [] });
    } else if (token.nesting === -1) {
      const frame = stack.pop();
      if (!frame) continue;
      current().push(
        createElement(frame.element ?? Fragment, { key: key++, ...frame.props }, ...frame.children),
      );
    } else {
      current().push(leaf(token, key++, outline));
    }
  }
  return root;
}

/** `headingLevel` is the level the text's first heading takes: one below the
    heading the text sits under. */
export function Markdown({ source, headingLevel = 3 }: { source: string; headingLevel?: number }) {
  const outline = new Outline(Math.max(2, Math.min(6, headingLevel)));
  return createElement("div", { className: "prose" }, ...build(parser.parse(source, {}), outline));
}
