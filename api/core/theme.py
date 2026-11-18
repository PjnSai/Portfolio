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

# (foreground, background, minimum ratio). 4.5:1 for text, 3:1 for the primary
# colour as an interface part against the page.
PAIRS = (
    ("ink", "bg", 4.5),
    ("ink", "surface", 4.5),
    ("on_primary", "primary", 4.5),
    *((f"on_accent_{n}", f"accent_{n}", 4.5) for n in ACCENTS),
    ("primary", "bg", 3.0),
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


# Preset E, made by migration 0009 with this fixed id so new settings can name it.
DEFAULT_PALETTE = "b399fb8f-5de4-462d-98f5-a81bf8046a6f"
