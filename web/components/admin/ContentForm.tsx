"use client";

import { useState } from "react";
import type { z } from "zod";
import { Button, FieldErrors, INPUT, Label } from "@/components/admin/ui";
import {
  EMPTY_ROW,
  type Field,
  fromForm,
  type ImageRow,
  type ItemData,
  LINK_KIND_OPTIONS,
  type LinkRow,
  type Pair,
  toForm,
} from "@/lib/admin/content-types";
import { issuesByField } from "@/lib/admin/schemas";
import { Markdown } from "@/lib/markdown";

export type SaveResult = { ok: boolean; fields: Record<string, string[]> };

export function ContentForm({
  fields,
  data,
  schema,
  submitLabel,
  onSave,
  clearAfterSave = false,
}: {
  fields: Field[];
  data: ItemData;
  schema: z.ZodType;
  submitLabel: string;
  onSave: (data: ItemData) => Promise<SaveResult>;
  clearAfterSave?: boolean;
}) {
  const [values, setValues] = useState(() => toForm(fields, data));
  const [errors, setErrors] = useState<Record<string, string[]>>({});
  const set = (name: string, value: unknown) => setValues({ ...values, [name]: value });

  return (
    <form
      className="space-y-5"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        const checked = schema.safeParse(fromForm(fields, values, data));
        if (!checked.success) {
          setErrors(issuesByField(checked.error));
          return;
        }
        const result = await onSave(checked.data as ItemData);
        setErrors(result.fields);
        if (result.ok && clearAfterSave) setValues(toForm(fields, {}));
      }}
    >
      {Object.keys(errors).length > 0 && (
        <p role="alert" className="rounded-md border-l-4 border-danger bg-panel px-4 py-3 text-sm text-danger">
          Some fields need changing. {errors.detail?.join(" ")}
        </p>
      )}
      {fields.map((field) => (
        <FieldEditor
          key={field.name}
          field={field}
          value={values[field.name]}
          errors={errors[field.name]}
          onChange={(value) => set(field.name, value)}
        />
      ))}
      <Button type="submit" variant="primary">
        {submitLabel}
      </Button>
    </form>
  );
}

function title(field: Field) {
  return `${field.label}${field.required ? "" : " (optional)"}${field.hint ? `: ${field.hint}` : ""}`;
}

function FieldEditor({
  field,
  value,
  errors,
  onChange,
}: {
  field: Field;
  value: unknown;
  errors?: string[];
  onChange: (value: unknown) => void;
}) {
  const invalid = errors?.length ? true : undefined;
  switch (field.kind) {
    case "text":
      return (
        <MarkdownField field={field} value={String(value ?? "")} errors={errors} onChange={onChange} />
      );
    case "list":
      return (
        <label className="block">
          <Label>{title(field)}</Label>
          <textarea
            className={`${INPUT} min-h-24`}
            aria-invalid={invalid}
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
          />
          <FieldErrors messages={errors} />
        </label>
      );
    case "choice":
      return (
        <label className="block">
          <Label>{title(field)}</Label>
          <select
            className={INPUT}
            aria-invalid={invalid}
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
          >
            {field.options?.map(([option, label]) => (
              <option key={option} value={option}>
                {label}
              </option>
            ))}
          </select>
          <FieldErrors messages={errors} />
        </label>
      );
    case "flag":
      return (
        <label className="flex min-h-11 items-center gap-3">
          <input
            type="checkbox"
            className="size-5"
            checked={value === true}
            onChange={(e) => onChange(e.target.checked)}
          />
          <span>{field.label}</span>
          <FieldErrors messages={errors} />
        </label>
      );
    case "pairs":
    case "links":
    case "images":
      return (
        <RowsField field={field} rows={(value as object[]) ?? []} errors={errors} onChange={onChange} />
      );
    case "image":
      return (
        <fieldset className="rounded-lg border border-line p-4">
          <legend className="px-1">
            <Label>{title(field)}</Label>
          </legend>
          {value ? (
            <ImageInputs
              row={value as ImageRow}
              onChange={onChange}
              onRemove={() => onChange(null)}
              removeLabel={`Remove ${field.label.toLowerCase()}`}
            />
          ) : (
            <Button onClick={() => onChange(EMPTY_ROW.images())}>Add {field.label.toLowerCase()}</Button>
          )}
          <FieldErrors messages={errors} />
        </fieldset>
      );
    default:
      return (
        <label className="block">
          <Label>{title(field)}</Label>
          <input
            className={INPUT}
            aria-invalid={invalid}
            type={field.kind === "url" ? "url" : "text"}
            inputMode={field.kind === "month" ? "numeric" : undefined}
            maxLength={field.max}
            value={String(value ?? "")}
            onChange={(e) => onChange(e.target.value)}
          />
          <FieldErrors messages={errors} />
        </label>
      );
  }
}

function MarkdownField({
  field,
  value,
  errors,
  onChange,
}: {
  field: Field;
  value: string;
  errors?: string[];
  onChange: (value: string) => void;
}) {
  const [preview, setPreview] = useState(false);
  return (
    <div>
      <div className="flex items-end justify-between gap-2">
        <Label>{title(field)}</Label>
        <Button className="mb-1 min-h-9 py-1" aria-pressed={preview} onClick={() => setPreview(!preview)}>
          {preview ? "Edit" : "Preview"}
        </Button>
      </div>
      {preview ? (
        <div className="min-h-24 rounded-md border border-line bg-paper p-3" data-testid="markdown-preview">
          <Markdown source={value} />
        </div>
      ) : (
        <textarea
          aria-label={field.label}
          aria-invalid={errors?.length ? true : undefined}
          className={`${INPUT} min-h-32`}
          maxLength={field.max}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {field.max ? (
        <span className="mt-1 block font-mono text-xs text-muted">
          {value.length} / {field.max}
        </span>
      ) : null}
      <FieldErrors messages={errors} />
    </div>
  );
}

function RowsField({
  field,
  rows,
  errors,
  onChange,
}: {
  field: Field;
  rows: object[];
  errors?: string[];
  onChange: (rows: object[]) => void;
}) {
  const update = (index: number, row: object) =>
    onChange(rows.map((old, i) => (i === index ? row : old)));
  const remove = (index: number) => onChange(rows.filter((_, i) => i !== index));
  const noun = field.kind === "images" ? "image" : field.kind === "links" ? "link" : "field";

  return (
    <fieldset className="rounded-lg border border-line p-4">
      <legend className="px-1">
        <Label>{title(field)}</Label>
      </legend>
      {rows.length === 0 && <p className="mb-3 text-sm text-muted">None yet.</p>}
      <ol className="space-y-4">
        {rows.map((row, index) => (
          <li key={index} className="border-b border-line pb-4 last:border-b-0">
            <p className="mb-2 font-mono text-xs uppercase text-muted">
              {noun} {index + 1}
            </p>
            {field.kind === "images" ? (
              <ImageInputs
                row={row as ImageRow}
                onChange={(next) => update(index, next)}
                onRemove={() => remove(index)}
                removeLabel={`Remove image ${index + 1}`}
              />
            ) : field.kind === "links" ? (
              <LinkInputs
                row={row as LinkRow}
                onChange={(next) => update(index, next)}
                onRemove={() => remove(index)}
                index={index}
              />
            ) : (
              <PairInputs
                row={row as Pair}
                onChange={(next) => update(index, next)}
                onRemove={() => remove(index)}
                index={index}
              />
            )}
          </li>
        ))}
      </ol>
      <Button className="mt-3" onClick={() => onChange([...rows, EMPTY_ROW[field.kind]()])}>
        Add {noun}
      </Button>
      <FieldErrors messages={errors} />
    </fieldset>
  );
}

function SmallInput({
  label,
  value,
  onChange,
  type = "text",
  max,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  max?: number;
}) {
  return (
    <label className="block grow">
      <Label>{label}</Label>
      <input
        className={INPUT}
        type={type}
        maxLength={max}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}

function PairInputs({
  row,
  onChange,
  onRemove,
  index,
}: {
  row: Pair;
  onChange: (row: Pair) => void;
  onRemove: () => void;
  index: number;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <SmallInput label="Label" max={60} value={row.label} onChange={(label) => onChange({ ...row, label })} />
      <SmallInput label="Value" max={300} value={row.value} onChange={(value) => onChange({ ...row, value })} />
      <Button variant="danger" aria-label={`Remove field ${index + 1}`} onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

function LinkInputs({
  row,
  onChange,
  onRemove,
  index,
}: {
  row: LinkRow;
  onChange: (row: LinkRow) => void;
  onRemove: () => void;
  index: number;
}) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <label className="block">
        <Label>Kind</Label>
        <select className={INPUT} value={row.kind} onChange={(e) => onChange({ ...row, kind: e.target.value })}>
          {LINK_KIND_OPTIONS.map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>
      <SmallInput label="Label" max={60} value={row.label} onChange={(label) => onChange({ ...row, label })} />
      <SmallInput
        label="Address"
        type="url"
        max={500}
        value={row.url}
        onChange={(url) => onChange({ ...row, url })}
      />
      <Button variant="danger" aria-label={`Remove link ${index + 1}`} onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}

function ImageInputs({
  row,
  onChange,
  onRemove,
  removeLabel,
}: {
  row: ImageRow;
  onChange: (row: ImageRow) => void;
  onRemove: () => void;
  removeLabel: string;
}) {
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        {row.media ? "Image chosen from the media library." : "No image file yet. Uploads come with the media library."}
      </p>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <SmallInput label="Alt text" max={300} value={row.alt} onChange={(alt) => onChange({ ...row, alt })} />
        <SmallInput
          label="Caption (optional)"
          max={300}
          value={row.caption ?? ""}
          onChange={(caption) => onChange({ ...row, caption })}
        />
        <Button variant="danger" aria-label={removeLabel} onClick={onRemove}>
          Remove
        </Button>
      </div>
    </div>
  );
}
