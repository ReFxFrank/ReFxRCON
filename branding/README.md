# ReFxRCON brand

The mark is a blue glass plate with two cut corners and a reticle; the wordmark is **REFXRCON**
set in Barlow Condensed SemiBold with 6% tracking, traced to outlines so nothing depends on
installed fonts.

Everything in this folder is generated. Edit the scripts, not the files:

```bash
bun run scripts/branding.ts        # the SVGs, plus static/favicon.svg
bun run scripts/branding-png.ts    # rasterises them into png/ and the app icons in static/
```

The PNG step used to be manual, which is why the rasters drifted from the vectors whenever the
brand changed. `branding-png.ts` drives Playwright's Chromium, so the PNGs are now exact copies
of the SVGs and regenerating them is one command. Playwright is not a project dependency — it is
resolved from a global install only when you run that script, so CI never needs it.

## Files

| File                                               | Use                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `refxrcon-logo-on-dark.svg` / `-on-light.svg`      | Primary horizontal lockup. Pick by background.                                                                |
| `refxrcon-logo-mono-white.svg` / `-mono-black.svg` | Single-colour lockup for print, embroidery, forced-colour modes.                                              |
| `refxrcon-stacked-on-dark.svg` / `-on-light.svg`   | Square-ish lockup for avatars and tiles.                                                                      |
| `refxrcon-mark.svg`, `refxrcon-mark-mono-*.svg`    | Mark alone (favicon, app icon, small spaces under 24px).                                                      |
| `refxrcon-wordmark-on-dark.svg` / `-on-light.svg`  | Wordmark alone.                                                                                               |
| `png/`                                             | Rasterised copies: mark at 16–1024px, lockups at 2x, stacked at 1024px wide, and the 1280×640 social preview. |

`static/favicon.svg`, `static/icon-192.png`, `static/icon-512.png` and
`static/apple-touch-icon.png` are generated from the same mark and are referenced by
`src/app.html`. Regenerate them with the brand, never by hand.

## Colours

| Token       | Hex       | Role                                    |
| ----------- | --------- | --------------------------------------- |
| Accent      | `#0068EF` | The lit top of the plate; the ReFx blue |
| Accent deep | `#0A3A80` | The shaded foot of the plate            |
| Ink         | `#070B12` | Dark background                         |
| Mist        | `#EEF6FF` | Reticle on the plate, and text on dark  |

The plate is a gradient, not a flat fill — that is the one structural difference from the brass
mark this replaces, and it is what makes it read as glass. Keep it whenever colour is available;
the mono variants exist for one-colour contexts only. Do not recolour, outline, rotate, add
effects, or set the wordmark in another face.

These colours are the same values as `--color-accent-deep`, `--color-ink-950` and
`--color-mist-100` in `src/app.css`. If you reskin the app, reskin the brand in the same pass or
the two drift apart.

## Clear space and minimum size

Leave clear space around the lockup equal to the height of the reticle's centre dot times 4 (about
a quarter of the mark's height). Use the mark alone below 24px in height; the horizontal lockup
stays legible down to 20px high.

## Fonts and licence

Barlow Condensed is licensed under the SIL Open Font License (`src/OFL.txt`). The outlines in these
SVGs are derived works you may use freely with the logo. The code in this repository is covered by
the MIT licence it inherits from [warcon](https://github.com/Esprit-De-Corps-Gaming/warcon); the
ReFxRCON marks in this folder are ReFx's own and are not covered by it. Please do not use them to
imply that a hosted service is run by ReFx.
