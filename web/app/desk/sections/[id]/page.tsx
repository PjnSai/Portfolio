"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useState } from "react";
import {
  Button,
  Card,
  FieldErrors,
  INPUT,
  Label,
  Notice,
  PageTitle,
  Pager,
} from "@/components/admin/ui";
import { allPages, api, ApiError, describeError, type Page } from "@/lib/admin/api";
import {
  type Field,
  fromForm,
  ITEM_FIELDS,
  type ItemData,
  toForm,
  typeLabel,
} from "@/lib/admin/content-types";
import { shortDate } from "@/lib/admin/time";
import { useLoaded } from "@/lib/admin/use-loaded";

type Detail = {
  id: string;
  type: string;
  visible: boolean;
  holds_items: boolean;
  published_at: string | null;
  draft: { title: string; body: string };
  unpublished_changes: boolean;
};

type Item = { id: string; visible: boolean; label: string; data: ItemData };
type Version = { version: number; created_at: string; title: string; items: number };

async function fetchSection(id: string, versionPage: number) {
  const detail = await api.get<Detail>(`/sections/${id}`);
  const items = detail.holds_items
    ? await allPages<Item>(`/sections/${id}/items`)
    : [];
  const versions = await api.get<Page<Version>>(`/sections/${id}/revisions`, {
    page: versionPage,
  });
  return { detail, items, versions };
}

type Act = (call: () => Promise<unknown>, message?: string) => Promise<boolean>;

export default function SectionEditor() {
  const { id } = useParams<{ id: string }>();
  const [versionPage, setVersionPage] = useState(1);
  const fetcher = useCallback(
    () => fetchSection(id, versionPage),
    [id, versionPage],
  );
  const { data, error: loadError, reload } = useLoaded(fetcher);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [fields, setFields] = useState<Record<string, string[]>>({});

  const act: Act = async (call, message = "") => {
    setError("");
    setDone("");
    setFields({});
    try {
      await call();
      await reload();
      setDone(message);
      return true;
    } catch (failure) {
      setError(describeError(failure));
      if (failure instanceof ApiError) setFields(failure.fields);
      return false;
    }
  };

  if (loadError instanceof ApiError && loadError.status === 404) {
    return (
      <Notice kind="error">
        This section no longer exists or is in the trash.{" "}
        <Link href="/desk/sections" className="underline">
          Back to sections
        </Link>
      </Notice>
    );
  }
  if (!data) {
    return loadError ? (
      <Notice kind="error">{describeError(loadError)}</Notice>
    ) : (
      <p className="text-muted">Loading…</p>
    );
  }

  const { detail: section, items, versions } = data;
  const itemFields = ITEM_FIELDS[section.type] ?? [];

  function moveItem(index: number, by: number) {
    const ids = items.map((item) => item.id);
    [ids[index], ids[index + by]] = [ids[index + by], ids[index]];
    return act(() => api.post(`/sections/${id}/items/reorder`, { ids }));
  }

  return (
    <>
      <p className="mb-2 font-mono text-xs uppercase tracking-wide text-muted">
        <Link href="/desk/sections" className="underline">
          Sections
        </Link>{" "}
        / {typeLabel(section.type)}
      </p>
      <PageTitle>{section.draft.title}</PageTitle>

      <div className="mb-8 flex flex-wrap items-center gap-4 rounded-lg border-2 border-ink p-4">
        <p className="grow text-sm" data-testid="publish-state">
          {section.unpublished_changes
            ? "The draft has changes that are not live yet."
            : "The live site shows this draft."}{" "}
          {section.published_at
            ? `Last published ${shortDate(section.published_at)}.`
            : "Never published."}
        </p>
        <Button
          variant="primary"
          onClick={() =>
            act(() => api.post(`/sections/${id}/publish`), "Published.")
          }
        >
          Publish
        </Button>
      </div>
      <Notice kind="error">{error}</Notice>
      <Notice kind="done">{done}</Notice>

      <DraftForm
        key={JSON.stringify(section.draft)}
        draft={section.draft}
        fields={fields}
        onSave={(changes) =>
          act(() => api.patch(`/sections/${id}`, changes), "Draft saved.")
        }
      />

      {section.holds_items && (
        <section aria-labelledby="items" className="mt-12">
          <h2 id="items" className="mb-4 text-2xl font-extrabold">
            Items
          </h2>
          {items.length === 0 && (
            <p className="mb-4 text-muted">No items yet.</p>
          )}
          <ol className="mb-6 space-y-3">
            {items.map((item, index) => (
              <li key={item.id}>
                <ItemRow
                  item={item}
                  fields={itemFields}
                  first={index === 0}
                  last={index === items.length - 1}
                  onMove={(by) => moveItem(index, by)}
                  act={act}
                />
              </li>
            ))}
          </ol>
          <Card>
            <h3 className="mb-4 text-lg font-bold">Add an item</h3>
            <ItemForm
              fields={itemFields}
              data={{}}
              submitLabel="Add item"
              onSave={(data) =>
                act(
                  () => api.post(`/sections/${id}/items`, { data }),
                  "Item added.",
                )
              }
            />
          </Card>
        </section>
      )}

      <section aria-labelledby="versions" className="mt-12">
        <h2 id="versions" className="mb-4 text-2xl font-extrabold">
          Published versions
        </h2>
        {versions.results.length ? (
          <ul className="divide-y divide-line rounded-lg border border-line bg-panel">
            {versions.results.map((version) => (
              <li
                key={version.version}
                className="flex flex-wrap items-center justify-between gap-3 p-4"
              >
                <span>
                  <strong>Version {version.version}</strong> ·{" "}
                  {shortDate(version.created_at)} · {version.items} items
                </span>
                <Button
                  onClick={() =>
                    act(
                      () =>
                        api.post(
                          `/sections/${id}/revisions/${version.version}/restore`,
                        ),
                      `Version ${version.version} is now the draft. Publish to make it live.`,
                    )
                  }
                >
                  Restore as draft
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">Nothing published yet.</p>
        )}
        <Pager
          page={versions.page}
          pages={versions.pages}
          onPage={setVersionPage}
        />
      </section>
    </>
  );
}

function DraftForm({
  draft,
  fields,
  onSave,
}: {
  draft: Detail["draft"];
  fields: Record<string, string[]>;
  onSave: (changes: { title: string; body: string }) => Promise<boolean>;
}) {
  const [title, setTitle] = useState(draft.title);
  const [body, setBody] = useState(draft.body ?? "");
  return (
    <form
      className="space-y-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave({ title, body });
      }}
    >
      <label className="block">
        <Label>Title</Label>
        <input
          className={INPUT}
          required
          maxLength={80}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <FieldErrors messages={fields.title} />
      </label>
      <label className="block">
        <Label>Text (Markdown)</Label>
        <textarea
          className={`${INPUT} min-h-40`}
          maxLength={20000}
          value={body}
          onChange={(e) => setBody(e.target.value)}
        />
        <FieldErrors messages={fields.body} />
      </label>
      <Button type="submit">Save draft</Button>
    </form>
  );
}

function ItemRow({
  item,
  fields,
  first,
  last,
  onMove,
  act,
}: {
  item: Item;
  fields: Field[];
  first: boolean;
  last: boolean;
  onMove: (by: number) => Promise<unknown>;
  act: Act;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div className="rounded-lg border border-line bg-panel p-4" data-testid="item-row">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p>
          <strong>{item.label}</strong>{" "}
          <span className="font-mono text-xs uppercase text-muted">
            {item.visible ? "Shown" : "Hidden"}
          </span>
        </p>
        <div className="flex flex-wrap gap-2">
          <Button aria-label={`Move ${item.label} up`} disabled={first} onClick={() => onMove(-1)}>
            Up
          </Button>
          <Button aria-label={`Move ${item.label} down`} disabled={last} onClick={() => onMove(1)}>
            Down
          </Button>
          <Button
            aria-label={`${item.visible ? "Hide" : "Show"} ${item.label}`}
            onClick={() =>
              act(() => api.post(`/items/${item.id}/visibility`, { visible: !item.visible }))
            }
          >
            {item.visible ? "Hide" : "Show"}
          </Button>
          <Button onClick={() => setEditing(!editing)} aria-expanded={editing}>
            {editing ? "Close" : "Edit"}
          </Button>
          <Button
            variant="danger"
            aria-label={`Move ${item.label} to the trash`}
            onClick={() => act(() => api.post(`/items/${item.id}/trash`))}
          >
            Trash
          </Button>
        </div>
      </div>
      {editing && (
        <div className="mt-4 border-t border-line pt-4">
          <ItemForm
            fields={fields}
            data={item.data}
            submitLabel="Save item"
            onSave={async (data) => {
              const saved = await act(
                () => api.patch(`/items/${item.id}`, { data }),
                "Item saved.",
              );
              if (saved) setEditing(false);
              return saved;
            }}
          />
        </div>
      )}
    </div>
  );
}

function ItemForm({
  fields,
  data,
  submitLabel,
  onSave,
}: {
  fields: Field[];
  data: ItemData;
  submitLabel: string;
  onSave: (data: ItemData) => Promise<boolean>;
}) {
  const [values, setValues] = useState(() => toForm(fields, data));

  return (
    <form
      className="space-y-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if ((await onSave(fromForm(fields, values, data))) && !Object.keys(data).length) {
          setValues(toForm(fields, {}));
        }
      }}
    >
      {fields.map((field) => (
        <label key={field.name} className="block">
          <Label>
            {field.label}
            {field.hint ? ` (${field.hint})` : ""}
          </Label>
          {field.kind === "text" || field.kind === "list" ? (
            <textarea
              className={`${INPUT} min-h-24`}
              required={field.required}
              value={values[field.name]}
              onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
            />
          ) : (
            <input
              className={INPUT}
              required={field.required}
              type={field.kind === "url" ? "url" : "text"}
              pattern={field.kind === "month" ? "[0-9]{4}-[0-9]{2}" : undefined}
              value={values[field.name]}
              onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
            />
          )}
        </label>
      ))}
      <Button type="submit" variant="primary">
        {submitLabel}
      </Button>
    </form>
  );
}
