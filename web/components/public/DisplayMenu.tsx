import { THEMES, type Theme } from "@/lib/public/boot-script";

export type PaletteOption = { id: string; name: string };

type Props = {
  /** The palettes a visitor may pick from; empty unless the owner chose "visitor picks". */
  palettes: readonly PaletteOption[];
  defaultId?: string;
};

const THEME_LABELS: Record<Theme, string> = {
  system: "Match my device",
  light: "Light",
  dark: "Dark",
};

// Prerendered hidden: without JavaScript nothing could apply a choice, and
// the theme follows the device. DisplayEnhancer shows it and wires it up.
export function DisplayMenu({ palettes, defaultId }: Props) {
  return (
    <div className="display" data-display hidden>
      <button
        type="button"
        className="display__toggle"
        aria-expanded="false"
        aria-controls="display-panel"
        data-display-toggle
      >
        Theme
      </button>
      <div className="display__panel" id="display-panel" hidden>
        <fieldset className="display__group">
          <legend className="label">Light or dark</legend>
          {THEMES.map((theme) => (
            <label className="display__option" key={theme}>
              <input type="radio" name="theme" value={theme} defaultChecked={theme === "system"} />
              {THEME_LABELS[theme]}
            </label>
          ))}
        </fieldset>
        {palettes.length > 1 ? (
          <fieldset className="display__group" data-palette-picker>
            <legend className="label">Colours</legend>
            {palettes.map((palette) => (
              <label className="display__option" key={palette.id}>
                <input
                  type="radio"
                  name="palette"
                  value={palette.id}
                  defaultChecked={palette.id === defaultId}
                />
                <span className="swatch" data-palette={palette.id} aria-hidden="true">
                  <span />
                  <span />
                  <span />
                </span>
                {palette.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        <p className="visually-hidden" aria-live="polite" data-display-status />
      </div>
    </div>
  );
}
