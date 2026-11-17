"use client";

import { useState } from "react";
import type { SaveResult } from "@/components/admin/ContentForm";
import { Button, FieldErrors, INPUT, Label } from "@/components/admin/ui";
import {
  contrast,
  failures,
  HEX,
  type Mode,
  MODES,
  PAIRS,
  type Theme,
  TOKEN_NAMES,
} from "@/lib/admin/contrast";

const MODE_NAMES: Record<Mode, string> = { light: "Light theme", dark: "Dark theme" };

export function ThemeEditor({
  theme: saved,
  presets,
  onSave,
}: {
  theme: Theme;
  presets: Record<string, Theme>;
  onSave: (theme: Theme) => Promise<SaveResult>;
}) {
  const [theme, setTheme] = useState<Theme>(() => structuredClone(saved));
  const [errors, setErrors] = useState<string[]>([]);
  const badColours = MODES.flatMap((mode) =>
    TOKEN_NAMES.filter(([token]) => !HEX.test(theme[mode][token])).map(
      ([, name]) => `${MODE_NAMES[mode]}: ${name} is not a colour like #1a2b3c.`,
    ),
  );
  const failing = failures(theme);
  const blocked = badColours.length > 0 || failing.length > 0;

  const set = (mode: Mode, token: string, value: string) =>
    setTheme({ ...theme, [mode]: { ...theme[mode], [token]: value } });

  return (
    <form
      noValidate
      className="space-y-6"
      onSubmit={async (event) => {
        event.preventDefault();
        if (blocked) return;
        const result = await onSave(theme);
        setErrors(result.fields.theme ?? []);
      }}
    >
      <div>
        <Label>Start from a palette</Label>
        <div className="flex flex-wrap gap-2">
          {Object.entries(presets).map(([name, preset]) => (
            <Button key={name} onClick={() => setTheme(structuredClone(preset))}>
              <span
                aria-hidden="true"
                className="mr-2 inline-block size-3 rounded-sm border border-ink align-middle"
                style={{ background: preset.light.accent }}
              />
              {name[0].toUpperCase() + name.slice(1)}
            </Button>
          ))}
        </div>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        {MODES.map((mode) => (
          <fieldset key={mode} className="rounded-lg border border-line p-4">
            <legend className="px-1 font-bold">{MODE_NAMES[mode]}</legend>
            <div className="space-y-3">
              {TOKEN_NAMES.map(([token, name]) => (
                <div key={token} className="flex items-end gap-2">
                  <label className="block grow">
                    <Label>{name}</Label>
                    <input
                      className={`${INPUT} font-mono`}
                      value={theme[mode][token]}
                      maxLength={7}
                      spellCheck={false}
                      onChange={(e) => set(mode, token, e.target.value.trim())}
                      aria-label={`${MODE_NAMES[mode]} ${name}`}
                    />
                  </label>
                  <input
                    type="color"
                    className="h-11 w-14 rounded-md border border-line bg-panel"
                    aria-label={`Pick ${MODE_NAMES[mode].toLowerCase()} ${name.toLowerCase()}`}
                    value={HEX.test(theme[mode][token]) ? theme[mode][token].toLowerCase() : "#000000"}
                    onChange={(e) => set(mode, token, e.target.value)}
                  />
                </div>
              ))}
            </div>
            <Preview theme={theme} mode={mode} />
          </fieldset>
        ))}
      </div>

      {blocked && (
        <div role="alert" className="rounded-md border-l-4 border-danger bg-panel px-4 py-3 text-sm text-danger">
          <p className="font-semibold">These colours cannot be saved:</p>
          <ul className="list-disc pl-5" data-testid="contrast-failures">
            {badColours.map((message) => (
              <li key={message}>{message}</li>
            ))}
            {failing.map((failure) => (
              <li key={`${failure.mode}-${failure.front}-${failure.back}`}>
                {MODE_NAMES[failure.mode]}: {failure.use} is {failure.ratio.toFixed(2)}:1; it needs at
                least {failure.minimum}:1.
              </li>
            ))}
          </ul>
        </div>
      )}
      <FieldErrors messages={errors} />
      <Button type="submit" variant="primary" disabled={blocked}>
        Save theme
      </Button>
    </form>
  );
}

function Preview({ theme, mode }: { theme: Theme; mode: Mode }) {
  const colours = theme[mode];
  if (Object.values(colours).some((value) => !HEX.test(value))) return null;
  return (
    <div className="mt-4">
      <div
        className="rounded-md border border-line p-4"
        style={{ background: colours.background, color: colours.ink }}
        data-testid={`preview-${mode}`}
      >
        <p className="mb-3 font-bold">Sample heading and body text.</p>
        <span
          className="inline-block rounded-md px-4 py-2 text-sm font-semibold"
          style={{ background: colours.accent, color: colours.on_accent }}
        >
          Sample button
        </span>
      </div>
      <ul className="mt-2 space-y-1 font-mono text-xs">
        {PAIRS.map((pair) => {
          const ratio = contrast(colours[pair.front], colours[pair.back]);
          const passes = ratio >= pair.minimum;
          return (
            <li key={pair.use} className={passes ? "text-ok" : "text-danger"}>
              {passes ? "Pass" : "Fail"} · {pair.use}: {ratio.toFixed(2)}:1 (needs {pair.minimum}:1)
            </li>
          );
        })}
      </ul>
    </div>
  );
}
