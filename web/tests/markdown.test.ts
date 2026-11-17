import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown, safeHref } from "@/lib/markdown";
import { createElement } from "react";

const html = (source: string) => renderToStaticMarkup(createElement(Markdown, { source }));

// Tags and attributes the renderer may produce; anything else is a failure.
const ALLOWED_TAGS = new Set([
  "div", "p", "h3", "h4", "ul", "ol", "li", "blockquote", "pre", "code",
  "hr", "em", "strong", "a", "br",
]);
const ALLOWED_ATTRIBUTES = new Set(["href", "rel", "class", "start"]);

function tagsIn(markup: string) {
  return [...markup.matchAll(/<\/?([a-zA-Z0-9]+)([^>]*)>/g)].map((m) => ({
    tag: m[1].toLowerCase(),
    attributes: [...m[2].matchAll(/\s([^\s=]+)=/g)].map((a) => a[1].toLowerCase()),
  }));
}

function expectInert(markup: string) {
  for (const { tag, attributes } of tagsIn(markup)) {
    expect(ALLOWED_TAGS, `tag <${tag}> in ${markup}`).toContain(tag);
    for (const attribute of attributes) {
      expect(ALLOWED_ATTRIBUTES, `attribute ${attribute} in ${markup}`).toContain(attribute);
    }
  }
  for (const href of markup.matchAll(/href="([^"]*)"/g)) {
    expect(href[1]).toMatch(/^(https:\/\/|\/(?!\/)|#)/);
  }
}

const XSS_PAYLOADS = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  '"><svg onload=alert(1)>',
  "<iframe src=https://evil.test></iframe>",
  "<a href=\"javascript:alert(1)\">x</a>",
  "[x](javascript:alert(1))",
  "[x](JaVaScRiPt:alert(1))",
  "[x](java&#115;cript:alert(1))",
  "[x](&#106;avascript:alert(1))",
  "[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
  "[x](vbscript:msgbox(1))",
  "[x](//evil.test/path)",
  "[x](http://plain.test/)",
  "[x](mailto:someone@example.test)",
  "[x]( javascript:alert(1))",
  '[x](https://ok.test/ "title onmouseover=alert(1)")',
  "![x](https://evil.test/track.png)",
  "![x](javascript:alert(1))",
  "<https://ok.test/><javascript:alert(1)>",
  "[ref]\n\n[ref]: javascript:alert(1)",
  "```html\n<script>alert(1)</script>\n```",
  "`<script>alert(1)</script>`",
  "<details open ontoggle=alert(1)>",
  "<style>body{display:none}</style>",
  "<!-- <script>alert(1)</script> -->",
  "**<b onclick=alert(1)>bold</b>**",
  "> <img src=x onerror=alert(1)>",
  "- [x](javascript:alert(1))\n- <svg/onload=alert(1)>",
  "\u0000<script>alert(1)</script>",
  "{{constructor.constructor('alert(1)')()}}",
];

describe("Markdown renderer", () => {
  it.each(XSS_PAYLOADS)("keeps %j inert", (payload) => {
    expectInert(html(payload));
  });

  it("shows raw HTML as text instead of dropping it", () => {
    const markup = html("Hello <script>alert(1)</script>");
    expect(markup).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).not.toContain("<script");
  });

  it("drops a script link but keeps its words", () => {
    const markup = html("[click me](javascript:alert(1))");
    expect(markup).toContain("click me");
    expect(markup).not.toContain("<a");
  });

  it("renders images as their alt text, not as images", () => {
    const markup = html("![Diagram of the API](https://ok.test/a.png)");
    expect(markup).not.toContain("<img");
    expect(markup).toContain("Diagram of the API");
  });

  it("renders ordinary Markdown", () => {
    const markup = html(
      "# Title\n\nSome **bold** and *soft* text with `code`.\n\n- one\n- two\n\n3. three\n\n" +
        "> quote\n\n```\nblock\n```\n\n---\n\n[Repo](https://github.test/o/r) and [top](#top)",
    );
    expect(markup).toContain("<h3>Title</h3>");
    expect(markup).toContain("<strong>bold</strong>");
    expect(markup).toContain("<em>soft</em>");
    expect(markup).toContain("<code>code</code>");
    expect(markup).toContain("<li>one</li>");
    expect(markup).toContain('<ol start="3">');
    expect(markup).toContain("<blockquote>");
    expect(markup).toContain("<pre><code>block\n</code></pre>");
    expect(markup).toContain("<hr/>");
    expect(markup).toContain('<a href="https://github.test/o/r" rel="noopener noreferrer nofollow">Repo</a>');
    expect(markup).toContain('<a href="#top">top</a>');
    expectInert(markup);
  });

  it("caps headings so they sit under the section heading", () => {
    expect(html("# a\n\n## b\n\n###### c")).toBe(
      '<div class="prose"><h3>a</h3><h4>b</h4><h4>c</h4></div>',
    );
  });

  it("renders empty input as nothing", () => {
    expect(html("")).toBe('<div class="prose"></div>');
  });
});

describe("safeHref", () => {
  it.each([
    ["https://ok.test/a?b=c#d", "https://ok.test/a?b=c#d"],
    ["/projects/ledger", "/projects/ledger"],
    ["#contact", "#contact"],
  ])("allows %s", (input, output) => {
    expect(safeHref(input)).toBe(output);
  });

  it.each([
    "javascript:alert(1)",
    "JAVASCRIPT:alert(1)",
    "data:text/html,x",
    "http://ok.test/",
    "//evil.test",
    "/\\evil.test",
    "https://user:pass@ok.test/",
    "mailto:a@b.test",
    "ftp://ok.test",
    "",
    "relative/path",
  ])("refuses %s", (input) => {
    expect(safeHref(input)).toBeNull();
  });
});
