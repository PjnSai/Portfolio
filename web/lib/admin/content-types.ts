// Section types and the fields each editor shows, matching core/serializers.py.

import { CARD_COLOURS, LAYOUTS, LINK_KINDS, STATUSES } from "./schemas";

export const SECTION_TYPES = [
  ["hero", "Intro"],
  ["about", "Profile"],
  ["projects", "Projects"],
  ["experience", "Experience"],
  ["education", "Education"],
  ["skills", "Skills"],
  ["text", "Text"],
  ["gallery", "Gallery"],
  ["contact", "Contact"],
  ["links", "Links"],
] as const;

export type SectionType = (typeof SECTION_TYPES)[number][0];

export function typeLabel(type: string): string {
  return SECTION_TYPES.find(([value]) => value === type)?.[1] ?? type;
}

export type FieldKind =
  | "line"
  | "text"
  | "month"
  | "list"
  | "tags"
  | "url"
  | "choice"
  | "flag"
  | "pairs"
  | "links"
  | "images"
  | "image";

export type Option = readonly [value: string, label: string];

export type Field = {
  name: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  hint?: string;
  max?: number;
  options?: readonly Option[];
};

const words = (values: readonly string[], labels: Record<string, string>) =>
  values.map((value) => [value, labels[value] ?? value] as const);

const STATUS_OPTIONS = words(STATUSES, {
  live: "Live (deployed)",
  demo: "Demo (limited online version)",
  local: "Local (runs on my machine)",
  in_progress: "In progress",
});
const COLOUR_OPTIONS = words(CARD_COLOURS, {
  orange: "Orange",
  blue: "Blue",
  pink: "Pink",
  olive: "Olive",
  yellow: "Yellow",
  ink: "Black",
});
export const LINK_KIND_OPTIONS = words(LINK_KINDS, {
  demo: "Live demo",
  repository: "Code",
  other: "Other",
});
const LAYOUT_OPTIONS = words(LAYOUTS, {
  ring: "Ring",
  vertical: "Vertical ring",
  stack: "Stack",
  train: "Train",
});

const TITLE: Field = { name: "title", label: "Section title", kind: "line", required: true, max: 80 };
const BODY: Field = { name: "body", label: "Text", kind: "text", hint: "Markdown", max: 20000 };

export const SECTION_FIELDS: Record<string, Field[]> = {
  hero: [
    TITLE,
    { name: "name", label: "Name", kind: "line", max: 80 },
    { name: "role", label: "Role title", kind: "line", max: 120 },
    { name: "body", label: "Short summary", kind: "text", hint: "Markdown", max: 1000 },
    { name: "availability", label: "Availability line", kind: "line", max: 160 },
  ],
  about: [
    TITLE,
    { name: "body", label: "About me", kind: "text", hint: "Markdown", max: 20000 },
    {
      name: "location",
      label: "Location",
      kind: "line",
      hint: "city or region only",
      max: 80,
    },
    { name: "photo", label: "Photo", kind: "image" },
  ],
};

export function sectionFields(type: string): Field[] {
  return SECTION_FIELDS[type] ?? [TITLE, BODY];
}

const DATES: Field[] = [
  { name: "start", label: "Start", kind: "month", required: true, hint: "YYYY-MM" },
  { name: "end", label: "End", kind: "month", hint: "YYYY-MM, empty if ongoing" },
  { name: "summary", label: "Summary", kind: "text", hint: "Markdown", max: 5000 },
];

export const ITEM_FIELDS: Record<string, Field[]> = {
  projects: [
    { name: "title", label: "Title", kind: "line", required: true, max: 120 },
    { name: "summary", label: "Short description", kind: "text", hint: "Markdown", max: 500 },
    { name: "status", label: "Status", kind: "choice", options: STATUS_OPTIONS },
    {
      name: "created",
      label: "Created",
      kind: "month",
      hint: "YYYY-MM, empty while in progress",
    },
    { name: "category", label: "Category", kind: "line", hint: "for the filter, e.g. Web", max: 40 },
    { name: "colour", label: "Card colour", kind: "choice", options: COLOUR_OPTIONS },
    { name: "tags", label: "Tags", kind: "tags", hint: "languages and tools, comma separated" },
    { name: "links", label: "Links", kind: "links" },
    { name: "fields", label: "Extra fields", kind: "pairs", hint: "for example Role, Team size" },
    { name: "images", label: "Images", kind: "images", hint: "up to 8" },
    { name: "body", label: "Case study", kind: "text", hint: "Markdown", max: 20000 },
  ],
  experience: [
    { name: "role", label: "Role", kind: "line", required: true, max: 120 },
    { name: "organisation", label: "Organisation", kind: "line", required: true, max: 120 },
    { name: "location", label: "Place", kind: "line", max: 120 },
    ...DATES,
    { name: "tags", label: "Tags", kind: "tags", hint: "comma separated" },
  ],
  education: [
    { name: "qualification", label: "Course", kind: "line", required: true, max: 120 },
    { name: "institution", label: "Institution", kind: "line", required: true, max: 120 },
    ...DATES.slice(0, 2),
    { name: "grade", label: "Grade", kind: "line", max: 60 },
    { name: "summary", label: "Notes", kind: "text", hint: "Markdown", max: 5000 },
  ],
  skills: [
    { name: "name", label: "Group name", kind: "line", required: true, max: 80 },
    { name: "skills", label: "Skills", kind: "list", required: true, hint: "one per line" },
  ],
  gallery: [
    { name: "alt", label: "Alt text", kind: "line", required: true, max: 300 },
    { name: "caption", label: "Caption", kind: "line", max: 300 },
  ],
  links: [
    { name: "label", label: "Label", kind: "line", required: true, max: 60 },
    { name: "url", label: "Address", kind: "url", required: true, hint: "https://…" },
  ],
};

export const SETTINGS_FIELDS: Field[] = [
  { name: "title", label: "Site title", kind: "line", required: true, max: 80 },
  { name: "description", label: "Site description", kind: "line", max: 300 },
  { name: "contact_form", label: "Contact form is open", kind: "flag" },
  { name: "showcase_layout", label: "Project showcase layout", kind: "choice", options: LAYOUT_OPTIONS },
  { name: "layout_switcher", label: "Let visitors switch the layout", kind: "flag" },
  { name: "social_image", label: "Social preview image", kind: "image" },
];

export type ItemData = Record<string, unknown>;
export type Pair = { label: string; value: string };
export type LinkRow = { kind: string; label: string; url: string };
export type ImageRow = { media: string | null; alt: string; caption: string };
export type FormValues = Record<string, unknown>;

const text = (value: unknown) => (typeof value === "string" ? value : "");
const rows = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const strings = (value: unknown) => rows<unknown>(value).filter((v) => typeof v === "string");

/** Form values for some data: text for text inputs, rows for row editors. */
export function toForm(fields: Field[], data: ItemData): FormValues {
  return Object.fromEntries(
    fields.map((field): [string, unknown] => {
      const value = data[field.name];
      switch (field.kind) {
        case "list":
          return [field.name, strings(value).join("\n")];
        case "tags":
          return [field.name, strings(value).join(", ")];
        case "flag":
          return [field.name, value === true];
        case "choice":
          return [field.name, text(value) || field.options?.[0]?.[0] || ""];
        case "pairs":
        case "links":
        case "images":
          return [field.name, rows(value).map((row) => ({ ...(row as object) }))];
        case "image":
          return [field.name, value && typeof value === "object" ? { ...value } : null];
        default:
          return [field.name, text(value)];
      }
    }),
  );
}

function split(value: unknown, separator: string | RegExp) {
  return text(value)
    .split(separator)
    .map((part) => part.trim())
    .filter(Boolean);
}

/** Data from form values, keeping any fields the form does not show. */
export function fromForm(fields: Field[], values: FormValues, previous: ItemData = {}): ItemData {
  const data: ItemData = { ...previous };
  for (const field of fields) {
    const value = values[field.name];
    switch (field.kind) {
      case "list":
        data[field.name] = split(value, "\n");
        break;
      case "tags":
        data[field.name] = split(value, ",");
        break;
      case "flag":
        data[field.name] = value === true;
        break;
      case "pairs":
      case "links":
      case "images":
        data[field.name] = rows(value);
        break;
      case "image":
        data[field.name] = value ?? null;
        break;
      default:
        data[field.name] = text(value);
    }
  }
  return data;
}

export const EMPTY_ROW: Record<string, () => object> = {
  pairs: (): Pair => ({ label: "", value: "" }),
  links: (): LinkRow => ({ kind: "repository", label: "", url: "" }),
  images: (): ImageRow => ({ media: null, alt: "", caption: "" }),
};
