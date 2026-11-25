import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LimitsFormView } from "@/components/admin/inbox/LimitsCard";
import { ApiError, describeError } from "@/lib/admin/api";
import {
  checkLimits,
  EDITABLE_LIMITS,
  type LimitName,
  type Limits,
  textsFrom,
} from "@/lib/admin/limits";

function limits(): Limits {
  return {
    editable: Object.fromEntries(
      EDITABLE_LIMITS.map((name) => [name, { value: 5, default: 5, min: 1, max: 50 }]),
    ) as Limits["editable"],
    fixed: [
      { name: "vital_action_wait", value: 1440, unit: "minutes" },
      { name: "sign_in_failures_per_client", value: 5, unit: "count" },
      { name: "blocklist_max_entries", value: 500, unit: "count" },
    ],
  };
}

function render(over: Partial<Parameters<typeof LimitsFormView>[0]> = {}) {
  const data = limits();
  return renderToStaticMarkup(
    <LimitsFormView
      limits={data}
      texts={textsFrom(data)}
      errors={{}}
      saved=""
      failed=""
      onChange={() => {}}
      onSubmit={() => {}}
      {...over}
    />,
  );
}

describe("the limits card", () => {
  it("has a labelled field for every editable limit, with its bounds and default", () => {
    const html = render();
    expect(html.match(/<input/g)).toHaveLength(EDITABLE_LIMITS.length);
    expect(html.match(/From 1 to 50\. Default 5\./g)).toHaveLength(EDITABLE_LIMITS.length);
    expect(html).toContain("Months a block lasts");
    for (const name of EDITABLE_LIMITS) {
      expect(html).toContain(`aria-describedby="limit-${name}-hint"`);
      expect(html).toContain(`id="limit-${name}-hint"`);
    }
  });

  it("says the blocklist size cap", () => {
    expect(render()).toContain("holds 500");
  });

  it("asks for a whole number only, and the form saves with a passkey", () => {
    const html = render();
    expect(html).toContain('inputMode="numeric"');
    expect(html).toContain("Whole numbers only");
    expect(html).toContain("Saving asks for your passkey");
    expect(html).toContain("Save limits");
  });

  it("shows a problem on the field and marks it invalid", () => {
    const data = limits();
    const texts = { ...textsFrom(data), max_links: "99" };
    const { errors } = checkLimits(texts, data);
    const html = render({ texts, errors });
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(1);
    expect(html).toContain("Use a number from 1 to 50. From 1 to 50.");
  });

  it("shows what the API said when it refuses, in words", () => {
    const failed = describeError(new ApiError(400, { errors: { max_links: ["Too big."] } }));
    const html = render({ failed });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Some fields need changing.");
    expect(render({ failed: describeError(new ApiError(403, { code: "elevation_required" })) })).toContain(
      "Confirm with your passkey first.",
    );
  });

  it("confirms a save", () => {
    expect(render({ saved: "Limits saved. They apply from the next message." })).toContain(
      "Limits saved.",
    );
  });

  it("lists the fixed limits read only, in words, with no field", () => {
    const html = render();
    const fixed = html.slice(html.indexOf("Fixed limits"));
    expect(fixed).toContain("Wait before a vital action can run");
    expect(fixed).toContain("24 hours");
    expect(fixed).toContain("Failed sign-ins before a lock-out, per visitor");
    expect(fixed).not.toContain("<input");
    expect(fixed).toContain("cannot be changed from this page");
  });

  it("only offers names it has a label for", () => {
    const names: LimitName[] = [...EDITABLE_LIMITS];
    expect(new Set(names).size).toBe(8);
  });
});
