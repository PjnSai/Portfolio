import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { BOOT_SCRIPT } from "@/lib/public/boot-script";
import { contentSecurityPolicy, EXTRA_SCRIPT_HASHES } from "@/lib/security-headers";

const A = "0c63ed98-cf1f-4c4d-945f-8725c81ab5b4";
const B = "bf7b0ec6-833c-4f4c-be66-03ce086e298a";
const E = "b399fb8f-5de4-462d-98f5-a81bf8046a6f";

class Memory {
  items = new Map<string, string>();
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
}

class Broken {
  getItem(): string | null {
    throw new Error("blocked");
  }
  setItem() {
    throw new Error("blocked");
  }
}

type Run = {
  mode?: string;
  ids?: string[];
  local?: Memory | Broken;
  session?: Memory | Broken;
  /** Reading window.localStorage itself throws, as with storage turned off. */
  denied?: boolean;
};

/** Runs the exact script text against a fake <html> and storage; returns its dataset. */
function boot({ mode = "fixed", ids = [A, B, E], local = new Memory(), session = new Memory(), denied }: Run) {
  const dataset: Record<string, string> = { palette: A, paletteMode: mode, palettes: ids.join(" ") };
  const window = denied
    ? Object.defineProperties({}, {
        localStorage: { get: () => { throw new Error("denied"); } },
        sessionStorage: { get: () => { throw new Error("denied"); } },
      })
    : { localStorage: local, sessionStorage: session };
  runInNewContext(BOOT_SCRIPT, { window, document: { documentElement: { dataset }, addEventListener() {} } });
  return dataset;
}

type Listener = { type: string; handler: (event: unknown) => void; capture: unknown };

/** Runs the script and returns the listeners it put on the document. */
function listeners() {
  const found: Listener[] = [];
  const document = {
    documentElement: { dataset: { palette: A, paletteMode: "fixed", palettes: A } },
    addEventListener: (type: string, handler: Listener["handler"], capture: unknown) =>
      found.push({ type, handler, capture }),
  };
  runInNewContext(BOOT_SCRIPT, { window: { localStorage: new Memory(), sessionStorage: new Memory() }, document });
  return found;
}

describe("the guard on the contact form", () => {
  const submit = (id: string) => {
    let prevented = false;
    const event = { target: { id }, preventDefault: () => (prevented = true) };
    for (const listener of listeners().filter((l) => l.type === "submit")) listener.handler(event);
    return prevented;
  };

  it("listens for submit on the whole document, before any other code, in the capture phase", () => {
    const submits = listeners().filter((l) => l.type === "submit");
    expect(submits).toHaveLength(1);
    expect(submits[0].capture).toBe(true);
  });

  it("stops the browser's own submit of the contact form, so it never leaves the page", () => {
    expect(submit("contact-form")).toBe(true);
  });

  it("leaves every other form alone", () => {
    expect(submit("search")).toBe(false);
    expect(submit("")).toBe(false);
  });
});

const stored = (entries: Record<string, string>) => {
  const memory = new Memory();
  for (const [key, value] of Object.entries(entries)) memory.setItem(key, value);
  return memory;
};

describe("the inline script's hash", () => {
  const hash = `sha256-${createHash("sha256").update(BOOT_SCRIPT, "utf8").digest("base64")}`;

  it("is listed in EXTRA_SCRIPT_HASHES, so the script and the hash cannot drift apart", () => {
    expect(EXTRA_SCRIPT_HASHES).toEqual([hash]);
  });

  it("is in every policy, public and admin, and no 'unsafe-inline' is", () => {
    for (const admin of [false, true]) {
      const policy = contentSecurityPolicy({ scripts: [], styles: [], api: "", admin });
      expect(policy).toContain(`'${hash}'`);
      expect(policy).not.toContain("unsafe-inline");
    }
  });

  it("has nothing that would end the script element early", () => {
    expect(BOOT_SCRIPT).not.toMatch(/<\/?script|<!--/i);
  });
});

describe("fixed mode", () => {
  it("uses the default and ignores a remembered choice", () => {
    expect(boot({ local: stored({ palette: E }) }).palette).toBe(A);
  });
});

describe("visitor picks", () => {
  it("uses the remembered palette", () => {
    expect(boot({ mode: "pick", local: stored({ palette: E }) }).palette).toBe(E);
  });

  it("falls back to the default if the remembered one was disabled or deleted", () => {
    expect(boot({ mode: "pick", ids: [A, B], local: stored({ palette: E }) }).palette).toBe(A);
    expect(boot({ mode: "pick", local: stored({ palette: "not-an-id" }) }).palette).toBe(A);
  });

  it("uses the default with nothing remembered", () => {
    expect(boot({ mode: "pick" }).palette).toBe(A);
  });
});

describe("rotate per visit", () => {
  it("starts on the default, then moves to the next enabled palette on each new visit", () => {
    const local = new Memory();
    const seen = [1, 2, 3, 4].map(() => boot({ mode: "rotate", local, session: new Memory() }).palette);
    expect(seen).toEqual([A, B, E, A]);
  });

  it("keeps one palette for the whole visit", () => {
    const local = new Memory();
    const session = new Memory();
    const first = boot({ mode: "rotate", local, session }).palette;
    expect(boot({ mode: "rotate", local, session }).palette).toBe(first);
    expect(boot({ mode: "rotate", local, session }).palette).toBe(first);
  });

  it("starts again from the default if the last palette was disabled", () => {
    const local = stored({ "palette-last": "gone" });
    expect(boot({ mode: "rotate", local }).palette).toBe(A);
  });

  it("ignores a remembered pick", () => {
    expect(boot({ mode: "rotate", local: stored({ palette: E }) }).palette).toBe(A);
  });

  it("stays on the default with one palette enabled", () => {
    expect(boot({ mode: "rotate", ids: [A], local: stored({ "palette-last": A }) }).palette).toBe(A);
  });
});

describe("storage that fails", () => {
  it.each([
    ["throws on every call", { local: new Broken(), session: new Broken() }],
    ["cannot be reached at all", { denied: true }],
  ])("falls back to the default and the system theme when it %s", (_, broken) => {
    for (const mode of ["fixed", "pick", "rotate"]) {
      const dataset = boot({ mode, ...broken });
      expect(dataset.palette).toBe(A);
      expect(dataset.theme).toBe("system");
    }
  });
});

describe("theme", () => {
  it.each([
    [undefined, "system"],
    ["light", "light"],
    ["dark", "dark"],
    ["purple", "system"],
  ])("a remembered %s gives data-theme=%s", (theme, expected) => {
    const local = theme ? stored({ theme }) : new Memory();
    expect(boot({ local }).theme).toBe(expected);
  });
});
