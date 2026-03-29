import type { BaseEntity, EntityContext } from './core.js';

/**
 * Supported color modes for light entities. Determines which color controls appear in the HA UI.
 *
 * - `'onoff'` — On/off only, no brightness or color control.
 * - `'brightness'` — Brightness control (0–255), no color.
 * - `'color_temp'` — Color temperature in mireds or Kelvin.
 * - `'hs'` — Hue/saturation color model.
 * - `'rgb'` — Red/green/blue color model.
 * - `'rgbw'` — RGB + dedicated white channel.
 * - `'rgbww'` — RGB + cold white + warm white channels.
 * - `'xy'` — CIE 1931 xy chromaticity color model.
 * - `'white'` — Dedicated white-only mode with brightness.
 */
export type ColorMode =
  | 'onoff'
  | 'brightness'
  | 'color_temp'
  | 'hs'
  | 'rgb'
  | 'rgbw'
  | 'rgbww'
  | 'xy'
  | 'white';

/** MQTT discovery configuration for light entities. */
export interface LightConfig {
  /** Color modes this light supports. Determines available UI controls. */
  supported_color_modes: ColorMode[];
  /** List of named effects (e.g. `['rainbow', 'pulse']`). */
  effect_list?: string[];
  /** Minimum color temperature in Kelvin (e.g. `2000`). */
  min_color_temp_kelvin?: number;
  /** Maximum color temperature in Kelvin (e.g. `6500`). */
  max_color_temp_kelvin?: number;
}

/**
 * Command received from HA when a user interacts with a light entity.
 * Contains the desired state and any color/brightness parameters.
 */
export interface LightCommand {
  /** Desired power state. */
  state: 'ON' | 'OFF';
  /** Brightness level (0–255). */
  brightness?: number;
  /** Color temperature in mireds. */
  color_temp?: number;
  /** RGB color as an object. */
  color?: { r: number; g: number; b: number };
  /** Color temperature in Kelvin. */
  color_temp_kelvin?: number;
  /** Hue/saturation color as `[hue, saturation]`. */
  hs_color?: [number, number];
  /** CIE xy color as `[x, y]`. */
  xy_color?: [number, number];
  /** RGB color as `[r, g, b]` (0–255 each). */
  rgb_color?: [number, number, number];
  /** RGBW color as `[r, g, b, w]`. */
  rgbw_color?: [number, number, number, number];
  /** RGBWW color as `[r, g, b, cold_w, warm_w]`. */
  rgbww_color?: [number, number, number, number, number];
  /** White channel brightness (0–255). */
  white?: number;
  /** Named effect to activate. */
  effect?: string;
  /** Transition time in seconds. */
  transition?: number;
}

/** Current state of a light entity published to HA. */
export interface LightState {
  /** Power state. */
  state: 'on' | 'off';
  /** Current brightness level (0–255). */
  brightness?: number;
  /** Active color mode. */
  color_mode?: ColorMode;
  /** Current color temperature in mireds. */
  color_temp?: number;
  /** Current color temperature in Kelvin. */
  color_temp_kelvin?: number;
  /** Current hue/saturation. */
  hs_color?: [number, number];
  /** Current CIE xy color. */
  xy_color?: [number, number];
  /** Current RGB color. */
  rgb_color?: [number, number, number];
  /** Current RGBW color. */
  rgbw_color?: [number, number, number, number];
  /** Current RGBWW color. */
  rgbww_color?: [number, number, number, number, number];
  /** Currently active effect name. */
  effect?: string;
}

/** Entity definition for a controllable light with optional color and brightness support. */
export interface LightDefinition extends BaseEntity<LightState, LightConfig> {
  type: 'light';
  /**
   * Called when HA sends a command to this light (turn on/off, change color, etc.).
   * @param command - The light command with desired state and parameters.
   */
  onCommand(this: EntityContext<LightState>, command: LightCommand): void | Promise<void>;
}
