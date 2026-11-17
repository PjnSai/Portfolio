"use client";

import { useCallback, useState } from "react";
import { useAdmin } from "@/components/admin/AdminApp";
import { ContentForm, type SaveResult } from "@/components/admin/ContentForm";
import { privacyWarnings, PublishBar, type Warning } from "@/components/admin/PublishBar";
import { ThemeEditor } from "@/components/admin/ThemeEditor";
import { Button, FieldErrors, INPUT, Label, Notice, PageTitle } from "@/components/admin/ui";
import { api, ApiError, describeError } from "@/lib/admin/api";
import { type ItemData, SETTINGS_FIELDS } from "@/lib/admin/content-types";
import type { Theme } from "@/lib/admin/contrast";
import { issuesByField, SEO_PAGES, settingsSchema } from "@/lib/admin/schemas";
import { useLoaded } from "@/lib/admin/use-loaded";

type Seo = Record<string, { title?: string; description?: string }>;

type Settings = {
  draft: ItemData & { theme: Theme; seo?: Seo };
  published_at: string | null;
  unpublished_changes: boolean;
  privacy_warnings: Warning[];
  theme_presets: Record<string, Theme>;
};

const PAGE_NAMES: Record<string, string> = {
  home: "Home page",
  projects: "Projects",
  privacy: "Privacy notice",
  security: "Security page",
  how_built: "How this site is built",
};

export default function SettingsPage() {
  const fetcher = useCallback(() => api.get<Settings>("/settings"), []);
  const { data, error: loadError, reload } = useLoaded(fetcher);
  const { refreshCache } = useAdmin();
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function save(changes: ItemData, message: string): Promise<SaveResult> {
    setError("");
    setDone("");
    try {
      await api.patch("/settings", changes);
      await reload();
      setDone(message);
      return { ok: true, fields: {} };
    } catch (failure) {
      setError(describeError(failure));
      return { ok: false, fields: failure instanceof ApiError ? failure.fields : {} };
    }
  }

  async function publish(confirm: boolean): Promise<Warning[] | null> {
    setError("");
    setDone("");
    try {
      const result = await api.post<{ cache_purged: boolean }>("/settings/publish", { confirm });
      await reload();
      await refreshCache().catch(() => undefined);
      setDone(result.cache_purged ? "Settings published." : "Settings published. The cache could not be cleared yet: see the notice above.");
      return null;
    } catch (failure) {
      const warnings = privacyWarnings(failure);
      if (!warnings) setError(describeError(failure));
      return warnings;
    }
  }

  if (!data) {
    return loadError ? (
      <Notice kind="error">{describeError(loadError)}</Notice>
    ) : (
      <p className="text-muted">Loading…</p>
    );
  }

  const key = JSON.stringify(data.draft);
  return (
    <>
      <PageTitle>Site settings</PageTitle>
      <PublishBar
        unpublished={data.unpublished_changes}
        publishedAt={data.published_at}
        warnings={data.privacy_warnings}
        publish={publish}
      />
      <Notice kind="error">{error}</Notice>
      <Notice kind="done">{done}</Notice>

      <section aria-labelledby="general" className="mb-12">
        <h2 id="general" className="mb-4 text-2xl font-extrabold">
          General
        </h2>
        <ContentForm
          key={key}
          fields={SETTINGS_FIELDS}
          data={data.draft}
          schema={settingsSchema}
          submitLabel="Save settings"
          onSave={(changes) => save(changes, "Settings saved.")}
        />
      </section>

      <section aria-labelledby="seo" className="mb-12">
        <h2 id="seo" className="mb-4 text-2xl font-extrabold">
          Search and sharing
        </h2>
        <SeoForm key={key} draft={data.draft} onSave={(seo) => save({ seo }, "Search details saved.")} />
      </section>

      <section aria-labelledby="theme">
        <h2 id="theme" className="mb-4 text-2xl font-extrabold">
          Theme colours
        </h2>
        <ThemeEditor
          key={key}
          theme={data.draft.theme}
          presets={data.theme_presets}
          onSave={(theme) => save({ theme }, "Theme saved.")}
        />
      </section>
    </>
  );
}

function SeoForm({
  draft,
  onSave,
}: {
  draft: Settings["draft"];
  onSave: (seo: Seo) => Promise<SaveResult>;
}) {
  const [seo, setSeo] = useState<Seo>(() => structuredClone(draft.seo ?? {}));
  const [errors, setErrors] = useState<string[]>([]);
  const set = (page: string, name: "title" | "description", value: string) =>
    setSeo({ ...seo, [page]: { ...seo[page], [name]: value } });

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={async (event) => {
        event.preventDefault();
        const checked = settingsSchema.safeParse({ ...draft, seo });
        if (!checked.success) {
          setErrors(issuesByField(checked.error).seo ?? ["Some fields need changing."]);
          return;
        }
        const result = await onSave(seo);
        setErrors(result.fields.seo ?? []);
      }}
    >
      {SEO_PAGES.map((page) => (
        <fieldset key={page} className="rounded-lg border border-line p-4">
          <legend className="px-1 font-bold">{PAGE_NAMES[page]}</legend>
          <div className="space-y-3">
            <label className="block">
              <Label>Page title (optional, up to 70 characters)</Label>
              <input
                className={INPUT}
                maxLength={70}
                value={seo[page]?.title ?? ""}
                onChange={(e) => set(page, "title", e.target.value)}
              />
            </label>
            <label className="block">
              <Label>Description (optional, up to 160 characters)</Label>
              <input
                className={INPUT}
                maxLength={160}
                value={seo[page]?.description ?? ""}
                onChange={(e) => set(page, "description", e.target.value)}
              />
            </label>
          </div>
        </fieldset>
      ))}
      <FieldErrors messages={errors} />
      <Button type="submit" variant="primary">
        Save search details
      </Button>
    </form>
  );
}
