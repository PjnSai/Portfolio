// Client checks for admin content, the same shapes and limits as
// api/core/serializers.py. They give quick, clear errors in the form; the API
// checks everything again and its answer wins.

import { z } from "zod";
import { PALETTE_MODES, type Slot, SLOTS } from "@/lib/palettes";
import { failures, HEX } from "./contrast";

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;
const LINE_BREAK = /[\r\n\u2028\u2029]/;
const MONTH = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const FILL_IN = "Fill this in.";

function line(max: number, required = true) {
  const base = z
    .string()
    .trim()
    .max(max, `Keep this to ${max} characters.`)
    .refine((v) => !CONTROL.test(v), "Remove the hidden control characters.")
    .refine((v) => !LINE_BREAK.test(v), "Keep this to one line.");
  return required ? base.refine((v) => v.length > 0, FILL_IN) : base.optional();
}

function markdown(max: number) {
  return z
    .string()
    .max(max, `Keep this to ${max} characters.`)
    .refine((v) => !CONTROL.test(v), "Remove the hidden control characters.")
    .optional();
}

function month(required = true) {
  const base = z
    .string()
    .refine((v) => v === "" || MONTH.test(v), "Use the form YYYY-MM, for example 2024-09.");
  return required ? base.refine((v) => v.length > 0, FILL_IN) : base.optional();
}

export function isHttpsUrl(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && Boolean(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

const httpsUrl = z.string().max(500).refine(isHttpsUrl, "Use a full https:// address.");

function once(values: string[]) {
  return new Set(values.map((v) => v.toLowerCase())).size === values.length;
}

function list(max: number, itemMax: number) {
  return z
    .array(line(itemMax) as z.ZodType<string>)
    .max(max, `At most ${max}.`)
    .refine(once, "Each entry only once.");
}

const imageSlot = z.strictObject({
  media: z.uuid("That image is not in the media library.").nullable().optional(),
  alt: line(300),
  caption: line(300, false),
});

const sectionBase = { title: line(80), body: markdown(20000) };

const plainSection = z.strictObject(sectionBase);

export const SECTION_SCHEMAS: Record<string, z.ZodType> = {
  hero: z.strictObject({
    ...sectionBase,
    body: markdown(1000),
    name: line(80, false),
    role: line(120, false),
    availability: line(160, false),
  }),
  about: z.strictObject({
    ...sectionBase,
    location: line(80, false),
    photo: imageSlot.nullable().optional(),
  }),
};
for (const type of ["projects", "experience", "education", "skills", "text", "gallery", "contact", "links"]) {
  SECTION_SCHEMAS[type] = plainSection;
}

export const STATUSES = ["live", "demo", "local", "in_progress"] as const;
export const CARD_COLOURS = ["orange", "blue", "pink", "olive", "yellow", "ink"] as const;
export const LINK_KINDS = ["demo", "repository", "other"] as const;
export const LAYOUTS = ["ring", "vertical", "stack", "train"] as const;
export const SEO_PAGES = ["home", "projects", "privacy", "security", "how_built"] as const;

const dated = {
  start: month(),
  end: month(false),
  summary: markdown(5000),
};

function endAfterStart(value: { start?: string; end?: string }) {
  return !value.end || !value.start || value.end >= value.start;
}

export const ITEM_SCHEMAS: Record<string, z.ZodType> = {
  projects: z.strictObject({
    title: line(120),
    summary: markdown(500),
    body: markdown(20000),
    status: z.enum(STATUSES).optional(),
    created: month(false),
    category: line(40, false),
    colour: z.enum(CARD_COLOURS).optional(),
    tags: list(30, 40).optional(),
    links: z
      .array(z.strictObject({ kind: z.enum(LINK_KINDS), label: line(60), url: httpsUrl }))
      .max(10, "At most 10 links.")
      .optional(),
    fields: z
      .array(z.strictObject({ label: line(60), value: line(300) }))
      .max(20, "At most 20 fields.")
      .optional(),
    images: z.array(imageSlot).max(8, "At most 8 images.").optional(),
  }),
  experience: z
    .strictObject({
      ...dated,
      organisation: line(120),
      role: line(120),
      location: line(120, false),
      tags: list(20, 40).optional(),
    })
    .refine(endAfterStart, { message: "End is before the start.", path: ["end"] }),
  education: z
    .strictObject({
      ...dated,
      institution: line(120),
      qualification: line(120),
      grade: line(60, false),
    })
    .refine(endAfterStart, { message: "End is before the start.", path: ["end"] }),
  skills: z.strictObject({ name: line(80), skills: list(50, 60) }),
  gallery: imageSlot,
  links: z.strictObject({ label: line(60), url: httpsUrl }),
};

const colour = z.string().regex(HEX, "Use a colour like #1A2B3C.");
const slots = z.strictObject(
  Object.fromEntries(SLOTS.map((slot) => [slot, colour])) as Record<Slot, typeof colour>,
);

export const paletteSchema = z
  .strictObject({ name: line(60), light: slots, dark: slots })
  .superRefine((palette, context) => {
    for (const failure of failures(palette)) {
      context.addIssue({ code: "custom", message: failure.message, path: [failure.mode] });
    }
  });

const paletteChoice = {
  palette_mode: z.enum(PALETTE_MODES),
  default_palette_id: z.uuid(),
  enabled_palette_ids: z.array(z.uuid()).min(1).max(17),
};

function defaultIsEnabled(choice: { default_palette_id: string; enabled_palette_ids: string[] }) {
  return choice.enabled_palette_ids.includes(choice.default_palette_id);
}

const DEFAULT_ENABLED = { message: "The default must be one of the enabled.", path: ["default_palette_id"] };

export const paletteChoiceSchema = z.strictObject(paletteChoice).refine(defaultIsEnabled, DEFAULT_ENABLED);

const pageSeo = z.strictObject({ title: line(70, false), description: line(160, false) });

export const settingsSchema = z.strictObject({
  title: line(80),
  description: line(300, false),
  contact_form: z.boolean(),
  showcase_layout: z.enum(LAYOUTS),
  layout_switcher: z.boolean(),
  seo: z
    .strictObject(Object.fromEntries(SEO_PAGES.map((page) => [page, pageSeo.optional()])))
    .optional(),
  social_image: imageSlot.nullable().optional(),
  ...paletteChoice,
}).refine(defaultIsEnabled, DEFAULT_ENABLED);

/** zod issues as messages per top-level field, naming the row for lists. */
export function issuesByField(error: z.ZodError): Record<string, string[]> {
  const fields: Record<string, string[]> = {};
  for (const issue of error.issues) {
    const [name = "detail", row] = issue.path;
    const prefix = typeof row === "number" ? `Row ${row + 1}: ` : "";
    (fields[String(name)] ??= []).push(prefix + issue.message);
  }
  return fields;
}
