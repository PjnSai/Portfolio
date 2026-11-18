"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";
import { ADMIN } from "@/components/admin/AdminApp";
import { Button, FieldErrors, Notice } from "@/components/admin/ui";
import { api, ApiError, describeError } from "@/lib/admin/api";
import { useLoaded } from "@/lib/admin/use-loaded";
import { type AdminPalette, PALETTE_MODES, type PaletteChoice, type PaletteUse } from "@/lib/palettes";
import { SwatchStrip } from "./Swatches";

type Listing = PaletteChoice & { palettes: AdminPalette[]; max_custom: number };

const MODE_TEXT: Record<PaletteUse, { label: string; text: string }> = {
  fixed: { label: "Fixed", text: "Every visitor sees the default palette." },
  rotate: {
    label: "Rotate per visit",
    text: "Each new visit gets the next enabled palette in turn, starting with the default.",
  },
  pick: {
    label: "Visitor picks",
    text: "Visitors start on the default and can choose any enabled palette from the menu.",
  },
};

const REFUSED: Record<string, string> = {
  default: "This palette is the default, here or on the live site. Choose another default and publish first.",
  palette_limit: "You already have the most custom palettes allowed. Delete one first.",
  preset: "Presets cannot be changed or deleted. Duplicate one to edit it.",
};

function explain(failure: unknown): string {
  if (failure instanceof ApiError && failure.code && REFUSED[failure.code]) return REFUSED[failure.code];
  return describeError(failure);
}

const sameChoice = (one: PaletteChoice, two: PaletteChoice) =>
  one.palette_mode === two.palette_mode &&
  one.default_palette_id === two.default_palette_id &&
  one.enabled_palette_ids.join() === two.enabled_palette_ids.join();

type Status = {
  error: string;
  done: string;
  fields: Record<string, string[]>;
  trashed: { id: string; name: string } | null;
};
const CLEAR: Status = { error: "", done: "", fields: {}, trashed: null };

/** The palettes, which of them visitors get, and how. Saves to the draft settings. */
export function PaletteList({ onChanged }: { onChanged: () => Promise<void> }) {
  const fetcher = useCallback(() => api.get<Listing>("/palettes"), []);
  const { data, error: loadError, reload } = useLoaded(fetcher);
  const [status, setStatus] = useState<Status>(CLEAR);
  const router = useRouter();

  async function act(call: () => Promise<unknown>, done: Partial<Status>) {
    setStatus(CLEAR);
    try {
      await call();
      await reload();
      await onChanged();
      setStatus({ ...CLEAR, ...done });
    } catch (failure) {
      setStatus({ ...CLEAR, error: explain(failure), fields: failure instanceof ApiError ? failure.fields : {} });
    }
  }

  async function duplicate(palette: AdminPalette) {
    setStatus(CLEAR);
    try {
      const copy = await api.post<AdminPalette>(`/palettes/${palette.id}/duplicate`, {});
      router.push(`${ADMIN}/settings/palette?id=${copy.id}`);
    } catch (failure) {
      setStatus({ ...CLEAR, error: explain(failure) });
    }
  }

  if (!data) {
    return loadError ? (
      <Notice kind="error">{describeError(loadError)}</Notice>
    ) : (
      <p className="text-muted">Loading palettes…</p>
    );
  }
  const trashed = status.trashed;
  return (
    <div className="space-y-6">
      <Notice kind="error">{status.error}</Notice>
      <Notice kind="done">{status.done}</Notice>
      {trashed && (
        <p role="status" className="flex flex-wrap items-center gap-3 rounded-md border-l-4 border-ok bg-panel px-4 py-3 text-sm">
          <span>“{trashed.name}” moved to the trash. It can be restored for 30 days.</span>
          <Button
            onClick={() =>
              act(() => api.post(`/palettes/${trashed.id}/restore`), { done: `“${trashed.name}” is back.` })
            }
          >
            Restore {trashed.name}
          </Button>
        </p>
      )}
      <Choice
        key={JSON.stringify(data)}
        listing={data}
        fields={status.fields}
        act={act}
        duplicate={duplicate}
      />
    </div>
  );
}

function Choice({
  listing,
  fields,
  act,
  duplicate,
}: {
  listing: Listing;
  fields: Record<string, string[]>;
  act: (call: () => Promise<unknown>, done: Partial<Status>) => Promise<void>;
  duplicate: (palette: AdminPalette) => Promise<void>;
}) {
  const saved: PaletteChoice = {
    palette_mode: listing.palette_mode,
    default_palette_id: listing.default_palette_id,
    enabled_palette_ids: listing.enabled_palette_ids,
  };
  const [choice, setChoice] = useState<PaletteChoice>(saved);
  const dirty = !sameChoice(choice, saved);
  const custom = listing.palettes.filter((p) => p.kind === "custom").length;

  function setEnabled(id: string, on: boolean) {
    // Keep the list in the order palettes are shown.
    const next = listing.palettes
      .map((p) => p.id)
      .filter((p) => (p === id ? on : choice.enabled_palette_ids.includes(p)));
    setChoice({ ...choice, enabled_palette_ids: next });
  }

  function setDefault(id: string) {
    const enabled = choice.enabled_palette_ids.includes(id)
      ? choice.enabled_palette_ids
      : listing.palettes.map((p) => p.id).filter((p) => p === id || choice.enabled_palette_ids.includes(p));
    setChoice({ ...choice, default_palette_id: id, enabled_palette_ids: enabled });
  }

  function trash(palette: AdminPalette) {
    return act(() => api.post(`/palettes/${palette.id}/trash`), {
      trashed: { id: palette.id, name: palette.name },
    });
  }

  return (
    <>
      <form
        noValidate
        className="space-y-6"
        onSubmit={async (event) => {
          event.preventDefault();
          await act(() => api.post("/palettes/use", choice), {
            done: "Palette choice saved. Publish to show it to visitors.",
          });
        }}
      >
        <fieldset className="rounded-lg border border-line p-4">
          <legend className="px-1 font-bold">How visitors get a palette</legend>
          <div className="space-y-3">
            {PALETTE_MODES.map((mode) => (
              <label key={mode} className="flex min-h-11 items-start gap-3">
                <input
                  type="radio"
                  name="palette-mode"
                  className="mt-1 size-5 shrink-0"
                  checked={choice.palette_mode === mode}
                  onChange={() => setChoice({ ...choice, palette_mode: mode })}
                  aria-describedby={`mode-${mode}-text`}
                />
                <span>
                  <span className="block font-semibold">{MODE_TEXT[mode].label}</span>
                  <span id={`mode-${mode}-text`} className="block text-sm text-muted">
                    {MODE_TEXT[mode].text}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <FieldErrors messages={fields.palette_mode} />
        </fieldset>

        <p className="text-sm text-muted">
          {custom} of {listing.max_custom} custom palettes used. Tick the palettes visitors may get and choose one
          default. The default is always enabled.
        </p>
        <FieldErrors messages={[...(fields.default_palette_id ?? []), ...(fields.enabled_palette_ids ?? [])]} />

        <ul className="space-y-3" aria-label="Palettes">
          {listing.palettes.map((palette) => {
            const isDefault = choice.default_palette_id === palette.id;
            const enabled = choice.enabled_palette_ids.includes(palette.id);
            return (
              <li
                key={palette.id}
                data-testid="palette-row"
                className="flex flex-col gap-3 rounded-lg border border-line bg-panel p-4 md:flex-row md:items-center md:justify-between"
              >
                <div className="min-w-0 space-y-2">
                  <p className="flex flex-wrap items-center gap-2">
                    <strong>{palette.name}</strong>
                    <span className="rounded-md border border-ink px-2 py-0.5 font-mono text-xs uppercase">
                      {palette.kind === "preset" ? "Preset" : "Custom"}
                    </span>
                  </p>
                  <SwatchStrip label="Light" colours={palette.light} />
                  <SwatchStrip label="Dark" colours={palette.dark} />
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-5"
                      checked={enabled}
                      disabled={isDefault}
                      aria-label={`Enabled for visitors: ${palette.name}`}
                      onChange={(event) => setEnabled(palette.id, event.target.checked)}
                    />
                    Enabled for visitors
                  </label>
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="default-palette"
                      className="size-5"
                      checked={isDefault}
                      aria-label={`Default: ${palette.name}`}
                      onChange={() => setDefault(palette.id)}
                    />
                    Default
                  </label>
                  {palette.kind === "preset" ? (
                    <Button
                      aria-label={`Duplicate to edit: ${palette.name}`}
                      disabled={custom >= listing.max_custom}
                      onClick={() => duplicate(palette)}
                    >
                      Duplicate to edit
                    </Button>
                  ) : (
                    <>
                      <Link
                        href={`${ADMIN}/settings/palette?id=${palette.id}`}
                        aria-label={`Edit: ${palette.name}`}
                        className="inline-flex min-h-11 items-center rounded-md border border-line bg-panel px-4 text-sm font-semibold"
                      >
                        Edit
                      </Link>
                      <Button variant="danger" aria-label={`Delete: ${palette.name}`} onClick={() => trash(palette)}>
                        Delete
                      </Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>

        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" variant="primary">
            Save palette choice
          </Button>
          <span className="text-sm" aria-live="polite">
            {dirty ? "Unsaved changes to the palette choice." : ""}
          </span>
        </div>
      </form>
    </>
  );
}
