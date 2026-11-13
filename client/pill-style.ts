import type { PluginTheme } from "@getpaseo/plugin";
import type { ChipTone, PillTone } from "./pill-status";

type Colors = PluginTheme["colors"];

/** Sizes shared by the popover's parts. 44 is the smallest comfortable touch target. */
export const TOUCH = 44;
export const RADIUS = 12;
export const CARD_RADIUS = 14;

const HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

/** The six-digit form of a plain hex color, or undefined for anything else (rgb(), named, hsl...). */
function sixDigits(color: string): string | undefined {
  const match = HEX.exec(color.trim());
  if (!match) return undefined;
  return match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join("") : match[1];
}

function channels(color: string): [number, number, number] | undefined {
  const hex = sixDigits(color);
  return hex ? [0, 2, 4].map((at) => parseInt(hex.slice(at, at + 2), 16)) as [number, number, number] : undefined;
}

/** Dark themes have a dark base surface. Anything that is not a plain hex color counts as light. */
export function isDark(colors: Colors): boolean {
  const rgb = channels(colors.surface0);
  if (!rgb) return false;
  const [r, g, b] = rgb.map((value) => { const s = value / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.2;
}

/**
 * The status color at low opacity, the way the app builds its own status tints (a two-digit hex alpha:
 * 1f on light, 29 on dark). A theme color that is not a plain hex cannot take an alpha, so it gets the
 * fallback instead of a broken value.
 */
export function tint(color: string, alpha: number, fallback: string): string {
  const hex = sixDigits(color);
  if (!hex) return fallback;
  return `#${hex}${Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, "0")}`;
}

/** The icon color of a status. Text never uses it: a colored headline fails contrast on a tint in several themes. */
export function toneColor(tone: PillTone | ChipTone, colors: Colors): string {
  return tone === "success" ? colors.statusSuccess : tone === "danger" ? colors.statusDanger : colors.foregroundMuted;
}

/** Only a result that deserves attention gets a tinted band; everything else sits on the card. */
export function statusSurface(tone: PillTone, colors: Colors): string {
  if (tone !== "success" && tone !== "danger") return "transparent";
  return tint(toneColor(tone, colors), isDark(colors) ? 0x29 / 255 : 0x1f / 255, colors.surface2);
}

/** Opacity of a pressable: dimmer while pressed, a touch dimmer on hover (web and desktop), full otherwise. */
export function interaction(state: { pressed: boolean; hovered?: boolean }): number {
  return state.pressed ? 0.78 : state.hovered ? 0.92 : 1;
}
