"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { HexColorPicker } from "react-colorful";
import { fromRgb, parseChannel, parseHex, toRgb } from "@/lib/admin/colour";
import { usePaint } from "./paint";

const CHANNELS = [
  ["Red", "R"],
  ["Green", "G"],
  ["Blue", "B"],
] as const;

type Texts = { hex: string; rgb: [string, string, string] };

function textsOf(value: string): Texts {
  return { hex: value, rgb: toRgb(value).map(String) as Texts["rgb"] };
}

/**
 * One colour slot: a swatch button that opens a saturation square and hue
 * slider, plus hex and R/G/B fields. All four stay in step; a field only
 * changes the colour once it holds a whole, valid value.
 */
export function ColourField({
  id,
  label,
  slot,
  value,
  open,
  onToggle,
  onChange,
  messages,
}: {
  id: string;
  label: string;
  slot: string;
  value: string;
  open: boolean;
  onToggle: () => void;
  onChange: (hex: string) => void;
  messages: string[];
}) {
  const [texts, setTexts] = useState<Texts>(() => textsOf(value));
  const [shownFor, setShownFor] = useState(value);
  if (shownFor !== value) {
    setShownFor(value);
    setTexts(textsOf(value));
  }
  const paint = usePaint<HTMLButtonElement>({ "--swatch": value });
  const swatch = useRef<HTMLButtonElement | null>(null);
  const picker = useRef<HTMLDivElement | null>(null);
  const swatchRef = useCallback(
    (element: HTMLButtonElement | null) => {
      swatch.current = element;
      paint(element);
    },
    [paint],
  );
  // Opening the picker moves focus to its colour square; Escape comes back.
  useEffect(() => {
    if (open) picker.current?.querySelector<HTMLElement>('[role="slider"]')?.focus();
  }, [open]);
  const errorId = `${id}-errors`;
  const pickerId = `${id}-picker`;
  const described = messages.length ? errorId : undefined;
  const invalid = messages.length > 0;

  function setChannel(index: number, text: string) {
    const rgb = [...texts.rgb] as Texts["rgb"];
    rgb[index] = text;
    setTexts({ ...texts, rgb });
    const numbers = rgb.map(parseChannel);
    if (numbers.every((n) => n !== null)) onChange(fromRgb(numbers as [number, number, number]));
  }

  return (
    <fieldset className="min-w-0 rounded-md border border-line p-3" data-slot={slot}>
      <legend className="px-1 text-sm font-semibold">
        {label} <span className="font-mono text-xs text-muted">{slot}</span>
      </legend>
      <div className="flex flex-wrap items-end gap-2">
        <button
          ref={swatchRef}
          type="button"
          className="size-11 shrink-0 rounded-md border-2 border-ink bg-[var(--swatch)] outline-offset-2"
          aria-label={`Colour picker for ${label}`}
          aria-expanded={open}
          aria-controls={pickerId}
          aria-describedby={described}
          onClick={onToggle}
        />
        <label className="w-28">
          <span className="mb-1 block font-mono text-xs uppercase tracking-wide text-muted">Hex</span>
          <input
            className="min-h-11 w-full rounded-md border border-line bg-panel px-2 py-2 font-mono text-base text-ink"
            value={texts.hex}
            maxLength={7}
            spellCheck={false}
            autoComplete="off"
            aria-invalid={invalid || parseHex(texts.hex) === null}
            aria-describedby={described}
            onChange={(event) => {
              const text = event.target.value;
              setTexts({ ...texts, hex: text });
              const hex = parseHex(text);
              if (hex) onChange(hex);
            }}
            onBlur={() => setTexts(textsOf(value))}
          />
        </label>
        {CHANNELS.map(([name, short], index) => (
          <label key={name} className="w-16">
            <span className="mb-1 block font-mono text-xs uppercase tracking-wide text-muted">
              {short}
            </span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={255}
              step={1}
              aria-label={name}
              className="min-h-11 w-full rounded-md border border-line bg-panel px-2 py-2 font-mono text-base text-ink"
              value={texts.rgb[index]}
              onChange={(event) => setChannel(index, event.target.value)}
              onBlur={() => setTexts(textsOf(value))}
            />
          </label>
        ))}
      </div>
      {open && (
        <div
          id={pickerId}
          ref={picker}
          className="colour-picker mt-3"
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            onToggle();
            swatch.current?.focus();
          }}
        >
          <HexColorPicker color={value} onChange={(hex) => onChange(hex.toUpperCase())} />
          <p className="mt-2 text-xs text-muted">
            Arrow keys change the shade on the square and the hue on the bar. Escape closes the picker.
          </p>
        </div>
      )}
      {messages.length > 0 && (
        <ul id={errorId} className="mt-2 space-y-1 text-sm text-danger">
          {messages.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
    </fieldset>
  );
}
