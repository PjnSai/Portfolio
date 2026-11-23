"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useState } from "react";
import type { z } from "zod";
import { useAdmin } from "@/components/admin/AdminApp";
import { ContentForm, type SaveResult } from "@/components/admin/ContentForm";
import { privacyWarnings, PublishBar, type Warning } from "@/components/admin/PublishBar";
import { Button, Card, Notice, PageTitle, Pager } from "@/components/admin/ui";
import { allPages, api, ApiError, describeError, type Page } from "@/lib/admin/api";
import {
  type Field,
  ITEM_FIELDS,
  type ItemData,
  sectionFields,
  typeLabel,
} from "@/lib/admin/content-types";
import { ITEM_SCHEMAS, SECTION_SCHEMAS } from "@/lib/admin/schemas";
import { shortDate } from "@/lib/admin/time";
import { useLoaded } from "@/lib/admin/use-loaded";

type Detail = {
  id: string;
  type: string;
  visible: boolean;
  holds_items: boolean;
  published_at: string | null;
  draft: ItemData & { title: string };
  unpublished_changes: boolean;
  privacy_warnings: Warning[];
};

type Item = { id: string; visible: boolean; label: string; slug: string | null; data: ItemData };
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

type Act = (call: () => Promise<unknown>, message?: string) => Promise<SaveResult>;

// The page is one static file; the section id comes from the query string
// because sections are created after the site is built.
const ID = /^[0-9a-f-]{36}$/;

export default function SectionEditorPage() {
  return (
    <Suspense fallback={<p className="text-muted">Loading…</p>}>
      <SectionEditorFromQuery />
    </Suspense>
  );
}

function SectionEditorFromQuery() {
  const id = useSearchParams().get("id") ?? "";
  if (!ID.test(id)) {
    return (
      <Notice kind="error">
        No section chosen.{" "}
        <Link href="/desk/sections" className="underline">
          Back to sections
        </Link>
      </Notice>
    );
  }
  return <SectionEditor key={id} id={id} />;
}

function SectionEditor({ id }: { id: string }) {
  const [versionPage, setVersionPage] = useState(1);
  const fetcher = useCallback(
    () => fetchSection(id, versionPage),
    [id, versionPage],
  );
  const { data, error: loadError, reload } = useLoaded(fetcher);
  const { refreshCache } = useAdmin();
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  const act: Act = async (call, message = "") => {
    setError("");
    setDone("");
    try {
      await call();
      await reload();
      setDone(message);
      return { ok: true, fields: {} };
    } catch (failure) {
      setError(describeError(failure));
      return { ok: false, fields: failure instanceof ApiError ? failure.fields : {} };
    }
  };

  async function publish(confirm: boolean): Promise<Warning[] | null> {
    setError("");
    setDone("");
    try {
      const result = await api.post<{ cache_purged: boolean }>(`/sections/${id}/publish`, { confirm });
      await reload();
      await refreshCache().catch(() => undefined);
      setDone(result.cache_purged ? "Published." : "Published. The cache could not be cleared yet: see the notice above.");
      return null;
    } catch (failure) {
      const warnings = privacyWarnings(failure);
      if (!warnings) setError(describeError(failure));
      return warnings;
    }
  }

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
  const itemSchema = ITEM_SCHEMAS[section.type];

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

      <PublishBar
        unpublished={section.unpublished_changes}
        publishedAt={section.published_at}
        warnings={section.privacy_warnings}
        publish={publish}
      />
      <Notice kind="error">{error}</Notice>
      <Notice kind="done">{done}</Notice>

      <ContentForm
        key={JSON.stringify(section.draft)}
        fields={sectionFields(section.type)}
        data={section.draft}
        schema={SECTION_SCHEMAS[section.type]}
        submitLabel="Save draft"
        onSave={(changes) => act(() => api.patch(`/sections/${id}`, changes), "Draft saved.")}
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
                  schema={itemSchema}
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
            <ContentForm
              fields={itemFields}
              data={{}}
              schema={itemSchema}
              submitLabel="Add item"
              clearAfterSave
              onSave={(data) => act(() => api.post(`/sections/${id}/items`, { data }), "Item added.")}
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

function ItemRow({
  item,
  fields,
  schema,
  first,
  last,
  onMove,
  act,
}: {
  item: Item;
  fields: Field[];
  schema: z.ZodType;
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
          {item.slug ? (
            <span className="block font-mono text-xs text-muted" data-testid="item-address">
              Address: /projects/{item.slug} (kept if the title changes)
            </span>
          ) : null}
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
          <ContentForm
            fields={fields}
            data={item.data}
            schema={schema}
            submitLabel="Save item"
            onSave={async (data) => {
              const saved = await act(() => api.patch(`/items/${item.id}`, { data }), "Item saved.");
              if (saved.ok) setEditing(false);
              return saved;
            }}
          />
        </div>
      )}
    </div>
  );
}
