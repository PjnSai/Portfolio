// Section types and the fields of their items, matching core/serializers.py.

export const SECTION_TYPES = [
  ["hero", "Intro"],
  ["about", "About"],
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

export type FieldKind = "line" | "text" | "month" | "list" | "url";

export type Field = {
  name: string;
  label: string;
  kind: FieldKind;
  required?: boolean;
  hint?: string;
};

const DATES: Field[] = [
  { name: "start", label: "Start", kind: "month", required: true, hint: "YYYY-MM" },
  { name: "end", label: "End", kind: "month", hint: "YYYY-MM, empty if ongoing" },
  { name: "summary", label: "Summary", kind: "text", hint: "Markdown" },
];

export const ITEM_FIELDS: Record<string, Field[]> = {
  projects: [
    { name: "title", label: "Title", kind: "line", required: true },
    { name: "summary", label: "Summary", kind: "text" },
    { name: "body", label: "Write-up", kind: "text", hint: "Markdown" },
  ],
  experience: [
    { name: "organisation", label: "Organisation", kind: "line", required: true },
    { name: "role", label: "Role", kind: "line", required: true },
    { name: "location", label: "Location", kind: "line" },
    ...DATES,
  ],
  education: [
    { name: "institution", label: "Institution", kind: "line", required: true },
    { name: "qualification", label: "Qualification", kind: "line", required: true },
    ...DATES,
  ],
  skills: [
    { name: "name", label: "Group name", kind: "line", required: true },
    { name: "skills", label: "Skills", kind: "list", required: true, hint: "One per line" },
  ],
  gallery: [
    { name: "alt", label: "Alt text", kind: "line", required: true },
    { name: "caption", label: "Caption", kind: "line" },
  ],
  links: [
    { name: "label", label: "Label", kind: "line", required: true },
    { name: "url", label: "Address", kind: "url", required: true, hint: "https://…" },
  ],
};

export type ItemData = Record<string, unknown>;

/** Form values for an item, as strings. */
export function toForm(fields: Field[], data: ItemData): Record<string, string> {
  return Object.fromEntries(
    fields.map((field) => {
      const value = data[field.name];
      if (field.kind === "list") {
        return [field.name, Array.isArray(value) ? value.join("\n") : ""];
      }
      return [field.name, typeof value === "string" ? value : ""];
    }),
  );
}

/** Item data from form values, keeping any fields the form does not show. */
export function fromForm(
  fields: Field[],
  values: Record<string, string>,
  previous: ItemData = {},
): ItemData {
  const data: ItemData = { ...previous };
  for (const field of fields) {
    const value = values[field.name] ?? "";
    data[field.name] =
      field.kind === "list"
        ? value
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
        : value;
  }
  return data;
}
