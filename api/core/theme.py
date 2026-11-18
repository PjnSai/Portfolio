"""Palette colours as tokens, checked against WCAG AA contrast before they are kept.
web/lib/admin/contrast.ts does the same sums so the editor can warn as you type."""

MODES = ("light", "dark")
ACCENTS = (1, 2, 3, 4)

SLOTS = (
    "bg",
    "ink",
    "surface",
    "primary",
    "on_primary",
    *(f"accent_{n}" for n in ACCENTS),
    *(f"on_accent_{n}" for n in ACCENTS),
)

# (foreground, background, minimum ratio), all text at 4.5:1. The primary is a
# decorative fill with no rule against the page: no control may rely on a
# primary fill alone, so each carries an ink border or an ink label.
PAIRS = (
    ("ink", "bg", 4.5),
    ("ink", "surface", 4.5),
    ("on_primary", "primary", 4.5),
    *((f"on_accent_{n}", f"accent_{n}", 4.5) for n in ACCENTS),
)


def _channel(value):
    value /= 255
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def luminance(colour):
    red, green, blue = (_channel(int(colour[i : i + 2], 16)) for i in (1, 3, 5))
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast(one, two):
    lighter, darker = sorted((luminance(one), luminance(two)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def failures(mode, colours):
    """A message for each pair in one mode below its minimum; empty when all pass."""
    problems = []
    for front, back, minimum in PAIRS:
        ratio = contrast(colours[front], colours[back])
        if ratio < minimum:
            problems.append(
                f"{mode.title()}: {front} on {back} is {ratio:.2f}:1; "
                f"it needs at least {minimum}:1."
            )
    return problems


# Preset A, made by migration 0010 with this fixed id so new settings can name it.
DEFAULT_PALETTE = "0c63ed98-cf1f-4c4d-945f-8725c81ab5b4"
