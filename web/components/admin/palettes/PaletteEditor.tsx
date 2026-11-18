"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useState } from "react";
import { ADMIN } from "@/components/admin/AdminApp";
import { Button, FieldErrors, INPUT, Label, Notice } from "@/components/admin/ui";
import { api, ApiError, describeError } from "@/lib/admin/api";
import { checks, failures, shown } from "@/lib/admin/contrast";
import { NO_ERRORS, type ServerErrors, serverErrors } from "@/lib/admin/palette-errors";
import { type AdminPalette, MODES, type PaletteMode, type Slot, SLOTS, type Slots } from "@/lib/palettes";
import { ColourField } from "./ColourField";
import { PalettePreview } from "./PalettePreview";

export const SLOT_LABELS: Record<Slot, string> = {
  bg: "Page background",
  ink: "Text",
  surface: "Card background",
  primary: "Primary fill",
  on_primary: "Text on primary",
  accent_1: "Accent 1",
  accent_2: "Accent 2",
  accent_3: "Accent 3",
  accent_4: "Accent 4",
  on_accent_1: "Text on accent 1",
  on_accent_2: "Text on accent 2",
  on_accent_3: "Text on accent 3",
  on_accent_4: "Text on accent 4",
};

type Draft = { name: string; light: Slots; dark: Slots };
const sameDraft = (one: Draft, two: Draft) => JSON.stringify(one) === JSON.stringify(two);

/** Ask before leaving with unsaved changes: closing the tab or following a link. */
function useLeaveGuard(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    const click = (event: MouseEvent) => {
      const link = (event.target as Element | null)?.closest?.("a[href]");
      if (!link || link.getAttribute("target") === "_blank") return;
      if (!window.confirm("This palette has unsaved changes. Leave without saving?")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", unload);
    document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      document.removeEventListener("click", click, true);
    };
  }, [dirty]);
}

export function PaletteEditor({ palette }: { palette: AdminPalette }) {
  const initial: Draft = { name: palette.name, light: palette.light, dark: palette.dark };
  const [saved, setSaved] = useState<Draft>(initial);
  const [draft, setDraft] = useState<Draft>(initial);
  const [open, setOpen] = useState<string | null>(null);
  const [server, setServer] = useState<ServerErrors>(NO_ERRORS);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");
  const [busy, setBusy] = useState(false);

  const dirty = !sameDraft(draft, saved);
  useLeaveGuard(dirty);
  const failing = failures(draft);

  function setSlot(mode: PaletteMode, slot: Slot, value: string) {
    setDraft({ ...draft, [mode]: { ...draft[mode], [slot]: value } });
    setDone("");
  }

  function messagesFor(mode: PaletteMode, slot: Slot): string[] {
    const local = failing
      .filter((f) => f.mode === mode && (f.front === slot || f.back === slot))
      .map((f) => f.message);
    return [...new Set([...local, ...(server.slots[`${mode}.${slot}`] ?? [])])];
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    setDone("");
    if (!draft.name.trim()) {
      setServer({ ...NO_ERRORS, name: ["Give the palette a name."] });
      setError("Nothing was saved. Give the palette a name.");
      return;
    }
    if (failing.length) {
      setError(
        `Nothing was saved. ${failing.length} colour ${failing.length === 1 ? "pair is" : "pairs are"} too close in contrast; see the marked colours.`,
      );
      return;
    }
    setBusy(true);
    try {
      const result = await api.patch<AdminPalette>(`/palettes/${palette.id}`, draft);
      const next = { name: result.name, light: result.light, dark: result.dark };
      setSaved(next);
      setDraft(next);
      setServer(NO_ERRORS);
      setDone("Palette saved. Publish the site settings to show it to visitors.");
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 400) {
        setServer(serverErrors(failure.body.errors));
        setError("Nothing was saved. The server found problems; see the marked colours.");
      } else {
        setError(describeError(failure));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} noValidate className="space-y-8">
      <Notice>
        Changes reach visitors only after you publish.{" "}
        <Link href={`${ADMIN}/settings#publish`} className="underline underline-offset-4">
          Go to Publish on the settings page
        </Link>
        .
      </Notice>
      <Notice kind="error">{error}</Notice>
      <Notice kind="done">{done}</Notice>
      <p className="font-mono text-sm" data-testid="save-state" aria-live="polite">
        {dirty ? "Unsaved changes" : "All changes saved"}
      </p>

      <label className="block max-w-md">
        <Label>Palette name (up to 60 characters)</Label>
        <input
          className={INPUT}
          maxLength={60}
          value={draft.name}
          aria-invalid={server.name.length > 0}
          aria-describedby={server.name.length ? "palette-name-errors" : undefined}
          onChange={(event) => {
            setDraft({ ...draft, name: event.target.value });
            setServer({ ...server, name: [] });
          }}
        />
        {server.name.length > 0 && (
          <span id="palette-name-errors">
            <FieldErrors messages={server.name} />
          </span>
        )}
      </label>

      <div className="grid gap-8 lg:grid-cols-2">
        {MODES.map((mode) => (
          <section key={mode} aria-labelledby={`mode-${mode}`} className="min-w-0">
            <h2 id={`mode-${mode}`} className="mb-3 text-2xl font-extrabold">
              {mode === "light" ? "Light colours" : "Dark colours"}
            </h2>
            <div className="space-y-3">
              {SLOTS.map((slot) => (
                <ColourField
                  key={slot}
                  id={`${mode}-${slot}`}
                  slot={slot}
                  label={`${mode === "light" ? "Light" : "Dark"} ${SLOT_LABELS[slot].toLowerCase()}`}
                  value={draft[mode][slot]}
                  open={open === `${mode}.${slot}`}
                  onToggle={() => setOpen(open === `${mode}.${slot}` ? null : `${mode}.${slot}`)}
                  onChange={(value) => setSlot(mode, slot, value)}
                  messages={messagesFor(mode, slot)}
                />
              ))}
              <FieldErrors messages={server.slots[`${mode}.general`]} />
            </div>
            <ContrastTable mode={mode} colours={draft[mode]} />
          </section>
        ))}
      </div>

      <section aria-labelledby="preview-title">
        <h2 id="preview-title" className="mb-3 text-2xl font-extrabold">
          Preview
        </h2>
        <div className="grid gap-4 sm:grid-cols-2">
          {MODES.map((mode) => (
            <PalettePreview key={mode} mode={mode} colours={draft[mode]} />
          ))}
        </div>
      </section>

      <div className="sticky bottom-0 flex flex-wrap items-center gap-3 border-t-2 border-ink bg-paper py-3">
        <Button type="submit" variant="primary" disabled={busy}>
          Save palette
        </Button>
        <Button disabled={!dirty || busy} onClick={() => setDraft(saved)}>
          Undo unsaved changes
        </Button>
        <Link href={`${ADMIN}/settings`} className="min-h-11 content-center text-sm underline underline-offset-4">
          Back to settings
        </Link>
      </div>
    </form>
  );
}

function ContrastTable({ mode, colours }: { mode: PaletteMode; colours: Slots }) {
  const rows = checks(mode, colours);
  const name = mode === "light" ? "Light" : "Dark";
  return (
    <table className="mt-4 w-full text-sm" data-testid={`contrast-${mode}`}>
      <caption className="mb-2 text-left font-bold">{name} contrast (needs 4.5:1)</caption>
      <thead>
        <tr className="border-b border-line text-left font-mono text-xs uppercase tracking-wide text-muted">
          <th scope="col" className="py-1">Pair</th>
          <th scope="col" className="py-1">Ratio</th>
          <th scope="col" className="py-1">Result</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={`${row.front}-${row.back}`} className="border-b border-line">
            <th scope="row" className="py-1 text-left font-normal">
              {SLOT_LABELS[row.front]} on {SLOT_LABELS[row.back].toLowerCase()}
            </th>
            <td className="py-1 font-mono">{shown(row.ratio)}:1</td>
            <td className="py-1">
              <span
                className={`rounded-md border px-2 py-0.5 font-mono text-xs font-bold uppercase ${
                  row.passes ? "border-ok text-ok" : "border-danger text-danger"
                }`}
              >
                {row.passes ? "Pass" : "Fail"}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
