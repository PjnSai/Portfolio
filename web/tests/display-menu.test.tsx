import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DisplayMenu } from "@/components/public/DisplayMenu";
import { SiteNav } from "@/components/public/SiteNav";
import { paletteMode } from "@/lib/public/tokens";

/** The radios named `name`, in order, with their value and checked state. */
function radios(html: string, name: string) {
  return [...html.matchAll(/<input [^>]*>/g)]
    .map((match) => match[0])
    .filter((tag) => tag.includes(`name="${name}"`))
    .map((tag) => ({ value: /value="([^"]*)"/.exec(tag)?.[1], checked: tag.includes('checked=""') }));
}

const A = { id: "0c63ed98-cf1f-4c4d-945f-8725c81ab5b4", name: "Ink and signal red" };
const E = { id: "b399fb8f-5de4-462d-98f5-a81bf8046a6f", name: "Original" };

describe("theme menu markup", () => {
  it("is prerendered hidden, with a labelled disclosure button", () => {
    const html = renderToStaticMarkup(<DisplayMenu palettes={[]} />);
    expect(html).toMatch(/^<div class="display" data-display="true" hidden="">/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-controls="display-panel"');
    expect(html).toContain('id="display-panel" hidden=""');
    expect(html).toContain('aria-live="polite"');
  });

  it("always offers the three theme states, device first", () => {
    const html = renderToStaticMarkup(<DisplayMenu palettes={[]} />);
    const values = radios(html, "theme").map((input) => input.value);
    expect(values).toEqual(["system", "light", "dark"]);
    expect(html).toContain("<legend");
  });

  it("has no palette picker with no palettes or one (fixed and rotate pass none)", () => {
    for (const palettes of [[], [A]]) {
      const html = renderToStaticMarkup(<DisplayMenu palettes={palettes} defaultId={A.id} />);
      expect(html).not.toContain('name="palette"');
      expect(html).not.toContain("data-palette-picker");
    }
  });

  it("lists exactly the palettes given, the default checked, swatches hidden from readers", () => {
    const html = renderToStaticMarkup(<DisplayMenu palettes={[A, E]} defaultId={E.id} />);
    const inputs = radios(html, "palette");
    expect(inputs.map((input) => input.value)).toEqual([A.id, E.id]);
    expect(inputs.filter((input) => input.checked).map((input) => input.value)).toEqual([E.id]);
    expect(html).toContain(`class="swatch" data-palette="${E.id}" aria-hidden="true"`);
  });

  it("carries no style attributes (the policy allows none)", () => {
    const html = renderToStaticMarkup(<SiteNav name="N" sections={[]} palettes={[A, E]} defaultId={A.id} />);
    expect(html).not.toMatch(/\sstyle=/);
  });
});

describe("paletteMode", () => {
  it.each([
    ["fixed", "fixed"],
    ["rotate", "rotate"],
    ["pick", "pick"],
    [undefined, "fixed"],
    ["everything", "fixed"],
  ])("reads %s as %s", (value, expected) => {
    expect(paletteMode(value)).toBe(expected);
  });
});
