/**
 * Conversions between Homey's `light_hue` / `light_saturation` capabilities
 * (both 0..1) and the HeliaLux red/green/blue channels (each 0..100 percent).
 *
 * The lamp has a separate master dimmer (`brightness`, mapped to Homey's `dim`)
 * that applies on top of the three colour channels, so the colour itself is
 * always converted at full value. Folding the dim level into the RGB values as
 * well would dim the light twice.
 */

export type Rgb = { red: number; green: number; blue: number };
export type Hs = { hue: number; saturation: number };

/** Hue and saturation (0..1) to red/green/blue channel levels in percent (0..100). */
export function hsToRgbPercent({ hue, saturation }: Hs): Rgb {
  const h = ((hue % 1) + 1) % 1;
  const s = Math.min(1, Math.max(0, saturation));

  const sector = h * 6;
  const c = s;
  const x = c * (1 - Math.abs((sector % 2) - 1));

  let r = 0;
  let g = 0;
  let b = 0;
  if (sector < 1) [r, g, b] = [c, x, 0];
  else if (sector < 2) [r, g, b] = [x, c, 0];
  else if (sector < 3) [r, g, b] = [0, c, x];
  else if (sector < 4) [r, g, b] = [0, x, c];
  else if (sector < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];

  const m = 1 - c;
  return {
    red: Math.round((r + m) * 100),
    green: Math.round((g + m) * 100),
    blue: Math.round((b + m) * 100),
  };
}

/**
 * Red/green/blue channel levels in percent (0..100) back to hue and saturation.
 * Returns null for pure black, which carries no hue: the caller should keep the
 * hue and saturation it already has rather than snapping the colour wheel to red.
 */
export function rgbPercentToHs({ red, green, blue }: Rgb): Hs | null {
  const r = Math.min(1, Math.max(0, red / 100));
  const g = Math.min(1, Math.max(0, green / 100));
  const b = Math.min(1, Math.max(0, blue / 100));

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === 0) return null;

  const delta = max - min;
  const saturation = delta / max;
  if (delta === 0) return { hue: 0, saturation: 0 };

  let hue: number;
  if (max === r) hue = ((g - b) / delta) % 6;
  else if (max === g) hue = (b - r) / delta + 2;
  else hue = (r - g) / delta + 4;

  hue /= 6;
  if (hue < 0) hue += 1;

  return { hue, saturation };
}
