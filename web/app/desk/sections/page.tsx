"use client";

import Link from "next/link";
import { useAdmin } from "@/components/admin/AdminApp";
import { useCallback, useState } from "react";
import {
  Button,
  FieldErrors,
  INPUT,
  Label,
  Notice,
  PageTitle,
} from "@/components/admin/ui";
import { allPages, api, ApiError, describeError } from "@/lib/admin/api";
import { SECTION_TYPES, typeLabel } from "@/lib/admin/content-types";
import { shortDate } from "@/lib/admin/time";
import { useLoaded } from "@/lib/admin/use-loaded";

type Section = {
  id: string;
  type: string;
  title: string;
  visible: boolean;
  position: number;
  published_at: string | null;
};

export default function Sections() {
  const fetchSections = useCallback(() => allPages<Section>("/sections"), []);
  const { data: sections, error: loadError, reload } = useLoaded(fetchSections);
  const { refreshCache } = useAdmin();
  const [error, setError] = useState("");
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [type, setType] = useState("projects");
  const [title, setTitle] = useState("");

  async function act(call: () => Promise<unknown>) {
    setError("");
    setFields({});
    try {
      await call();
      await reload();
      void refreshCache().catch(() => undefined);
      return true;
    } catch (failure) {
      setError(describeError(failure));
      if (failure instanceof ApiError) setFields(failure.fields);
      return false;
    }
  }

  async function add(event: React.FormEvent) {
    event.preventDefault();
    if (await act(() => api.post("/sections", { type, title }))) setTitle("");
  }

  function move(index: number, by: number) {
    if (!sections) return;
    const ids = sections.map((s) => s.id);
    [ids[index], ids[index + by]] = [ids[index + by], ids[index]];
    return act(() => api.post("/sections/reorder", { ids }));
  }

  return (
    <>
      <PageTitle>Sections</PageTitle>
      <p className="mb-6 text-muted">
        Order, showing and hiding apply to the live site at once. Changes inside a
        section stay a draft until you publish it.
      </p>
      <Notice kind="error">{error || (loadError ? describeError(loadError) : "")}</Notice>
      {sections === null ? (
        <p className="text-muted">Loading…</p>
      ) : sections.length === 0 ? (
        <p className="text-muted">No sections yet. Add the first one below.</p>
      ) : (
        <ol aria-label="Sections in page order" className="space-y-3">
          {sections.map((section, index) => (
            <li
              key={section.id}
              data-testid="section-row"
              className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 sm:flex-row sm:items-center sm:justify-between"
            >
              <div>
                <Link
                  href={`/desk/sections/edit?id=${section.id}`}
                  className="text-lg font-bold underline-offset-4 hover:underline"
                >
                  {section.title}
                </Link>
                <p className="font-mono text-xs uppercase tracking-wide text-muted">
                  {typeLabel(section.type)} ·{" "}
                  <span data-testid="visibility">
                    {section.visible ? "Shown" : "Hidden"}
                  </span>{" "}
                  ·{" "}
                  {section.published_at
                    ? `Published ${shortDate(section.published_at)}`
                    : "Never published"}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  aria-label={`Move ${section.title} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  Up
                </Button>
                <Button
                  aria-label={`Move ${section.title} down`}
                  disabled={index === sections.length - 1}
                  onClick={() => move(index, 1)}
                >
                  Down
                </Button>
                <Button
                  aria-label={`${section.visible ? "Hide" : "Show"} ${section.title}`}
                  onClick={() =>
                    act(() =>
                      api.post(`/sections/${section.id}/visibility`, {
                        visible: !section.visible,
                      }),
                    )
                  }
                >
                  {section.visible ? "Hide" : "Show"}
                </Button>
                <Button
                  variant="danger"
                  aria-label={`Move ${section.title} to the trash`}
                  onClick={() => act(() => api.post(`/sections/${section.id}/trash`))}
                >
                  Trash
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}

      <form
        onSubmit={add}
        className="mt-10 grid gap-4 border-t-2 border-ink pt-6 sm:grid-cols-[12rem_1fr_auto] sm:items-end"
      >
        <h2 className="text-xl font-extrabold sm:col-span-3">Add a section</h2>
        <label className="block">
          <Label>Type</Label>
          <select className={INPUT} value={type} onChange={(e) => setType(e.target.value)}>
            {SECTION_TYPES.map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <FieldErrors messages={fields.type} />
        </label>
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
        <Button variant="primary" type="submit">
          Add section
        </Button>
      </form>
    </>
  );
}
