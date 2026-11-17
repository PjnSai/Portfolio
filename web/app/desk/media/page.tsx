"use client";

import { useCallback, useState } from "react";
import { Thumbnail } from "@/components/admin/MediaPicker";
import { Button, FieldErrors, INPUT, Label, Notice, PageTitle, Pager } from "@/components/admin/ui";
import { api, ApiError, describeError, type Page } from "@/lib/admin/api";
import { checkUpload, type MediaItem, mediaAltSchema } from "@/lib/admin/media";
import { useLoaded } from "@/lib/admin/use-loaded";

export default function MediaLibrary() {
  const [page, setPage] = useState(1);
  const fetcher = useCallback(() => api.get<Page<MediaItem>>("/media", { page }), [page]);
  const { data, error: loadError, reload } = useLoaded(fetcher);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [fields, setFields] = useState<Record<string, string[]>>({});
  const [busy, setBusy] = useState(false);

  async function act(call: () => Promise<unknown>, message: string) {
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
  }

  async function upload(form: HTMLFormElement) {
    const body = new FormData(form);
    const file = body.get("file");
    const alt = mediaAltSchema.safeParse({ alt: body.get("alt") ?? "" });
    const problems: Record<string, string[]> = {};
    if (!(file instanceof File) || file.size === 0) {
      problems.file = ["Choose an image."];
    } else {
      const problem = checkUpload(file);
      if (problem) problems.file = [problem];
    }
    if (!alt.success) problems.alt = alt.error.issues.map((issue) => issue.message);
    if (Object.keys(problems).length) {
      setDone("");
      setFields(problems);
      setError("Some fields need changing.");
      return;
    }
    setBusy(true);
    const ok = await act(() => api.upload("/media", body), "Image added.");
    setBusy(false);
    if (ok) form.reset();
  }

  return (
    <>
      <PageTitle>Media</PageTitle>
      <p className="mb-6 text-muted">
        Photos and project images. Each upload is checked, saved again without its location and camera
        details, and kept in up to three sizes. An image appears on the site only once a published
        section uses it.
      </p>

      <form
        className="mb-8 space-y-4 rounded-lg border-2 border-ink p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void upload(event.currentTarget);
        }}
      >
        <label className="block">
          <Label>Image (JPEG, PNG or WebP, under 8 MB)</Label>
          <input name="file" type="file" accept="image/jpeg,image/png,image/webp" className={INPUT} />
          <FieldErrors messages={fields.file} />
        </label>
        <label className="block">
          <Label>Alt text (what the image shows)</Label>
          <input name="alt" maxLength={300} className={INPUT} />
          <FieldErrors messages={fields.alt} />
        </label>
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? "Uploading…" : "Upload"}
        </Button>
      </form>

      <Notice kind="error">{error}</Notice>
      <Notice kind="done">{done}</Notice>

      {!data ? (
        loadError ? (
          <Notice kind="error">{describeError(loadError)}</Notice>
        ) : (
          <p className="text-muted">Loading…</p>
        )
      ) : data.results.length === 0 ? (
        <p className="text-muted">No images yet.</p>
      ) : (
        <ul className="space-y-3">
          {data.results.map((item) => (
            <MediaRow
              key={item.id}
              item={item}
              onSave={(alt) => act(() => api.patch(`/media/${item.id}`, { alt }), "Alt text saved.")}
              onTrash={() => act(() => api.post(`/media/${item.id}/trash`), "Moved to the trash.")}
            />
          ))}
        </ul>
      )}
      {data && <Pager page={data.page} pages={data.pages} onPage={setPage} />}
    </>
  );
}

function MediaRow({
  item,
  onSave,
  onTrash,
}: {
  item: MediaItem;
  onSave: (alt: string) => Promise<boolean>;
  onTrash: () => Promise<boolean>;
}) {
  const [alt, setAlt] = useState(item.alt);
  const [problem, setProblem] = useState<string[]>();
  return (
    <li
      data-testid="media-row"
      className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 sm:flex-row sm:items-end"
    >
      <Thumbnail id={item.id} alt={item.alt} />
      <label className="block grow">
        <Label>Alt text</Label>
        <input value={alt} maxLength={300} className={INPUT} onChange={(e) => setAlt(e.target.value)} />
        <FieldErrors messages={problem} />
        <span className="mt-1 block font-mono text-xs text-muted">
          {item.width} × {item.height}
        </span>
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => {
            const checked = mediaAltSchema.safeParse({ alt });
            setProblem(checked.success ? undefined : checked.error.issues.map((i) => i.message));
            if (checked.success) void onSave(checked.data.alt);
          }}
        >
          Save alt text
        </Button>
        <Button variant="danger" aria-label={`Move ${item.alt} to the trash`} onClick={() => void onTrash()}>
          Move to trash
        </Button>
      </div>
    </li>
  );
}
