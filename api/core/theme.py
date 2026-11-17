"""Theme colours as tokens, checked against WCAG AA contrast before they are kept.
web/lib/admin/contrast.ts does the same sums so the editor can warn as you type."""

MODES = ("light", "dark")

# (foreground, background, minimum ratio, what the pair is used for)
PAIRS = (
    ("ink", "background", 4.5, "Text on the background"),
    ("on_accent", "accent", 4.5, "Text on the accent colour"),
    ("accent", "background", 3.0, "The accent colour against the background"),
)

DEFAULT = {
    "light": {
        "background": "#f5efe3",
        "ink": "#161412",
        "accent": "#e2531b",
        "on_accent": "#161412",
    },
    "dark": {
        "background": "#161412",
        "ink": "#f5efe3",
        "accent": "#f06a35",
        "on_accent": "#161412",
    },
}

PRESETS = {
    "orange": DEFAULT,
    "blue": {
        "light": {
            "background": "#f5efe3",
            "ink": "#161412",
            "accent": "#2a55c7",
            "on_accent": "#ffffff",
        },
        "dark": {
            "background": "#161412",
            "ink": "#f5efe3",
            "accent": "#7a9cf0",
            "on_accent": "#161412",
        },
    },
    "olive": {
        "light": {
            "background": "#f5efe3",
            "ink": "#161412",
            "accent": "#6b7022",
            "on_accent": "#ffffff",
        },
        "dark": {
            "background": "#161412",
            "ink": "#f5efe3",
            "accent": "#b9bf5a",
            "on_accent": "#161412",
        },
    },
}


def _channel(value):
    value /= 255
    return value / 12.92 if value <= 0.04045 else ((value + 0.055) / 1.055) ** 2.4


def luminance(colour):
    red, green, blue = (_channel(int(colour[i : i + 2], 16)) for i in (1, 3, 5))
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast(one, two):
    lighter, darker = sorted((luminance(one), luminance(two)), reverse=True)
    return (lighter + 0.05) / (darker + 0.05)


def failures(tokens):
    """A message for each pair below its minimum; empty when all pass."""
    problems = []
    for mode in MODES:
        colours = tokens[mode]
        for front, back, minimum, use in PAIRS:
            ratio = contrast(colours[front], colours[back])
            if ratio < minimum:
                problems.append(
                    f"{mode.title()} theme: {use} is {ratio:.2f}:1; "
                    f"it needs at least {minimum}:1."
                )
    return problems
