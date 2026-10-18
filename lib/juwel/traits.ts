/**
 * Helpers for the product catalogue's trait descriptions.
 *
 * The cloud describes every product through GET /config/product/{productId}:
 * each trait carries a `msg_key` (the field name in the device state and in
 * writes) and a `value_schema`. Ported from traits.py in
 * https://github.com/Melle79/juwel-appcontrol.
 *
 * Only the HeliaLux and the SmartFeed were verified on hardware upstream; the
 * EccoFlow traits come from the catalogue alone.
 */

import type { DeviceTrait, ProductConfig, ValueSchema } from './types.js';

// HeliaLux
export const T_STATUS = '@core/traits/status';

// SmartFeed
export const T_FEED = '@core/traits/feed';
export const T_FEED_QUANTITY = '@core/traits/feed-quantity';
export const T_FEED_KEY_QUANTITY = '@core/traits/feed-key-quantity';
export const T_LED_SWITCH = '@core/traits/led-switch';

// EccoFlow
export const T_POWER = '@core/traits/power';
export const T_MODE = '@core/traits/mode';
export const T_SMART_FEED = '@core/traits/smart-feed';
export const T_POWER_LIMIT = '@core/traits/power-limit';
export const T_TIMER_RESET = '@core/traits/timer-reset';
export const T_SPEED_LPH = '@core/traits/speed-lph';

export type Traits = Map<string, DeviceTrait>;

/** { trait id -> trait } for one product. */
export function parseTraits(config: ProductConfig | null | undefined): Traits {
  const traits: Traits = new Map();
  for (const entry of config?.deviceTraits ?? []) {
    if (entry.trait && entry.msg_key) traits.set(entry.trait, entry);
  }
  return traits;
}

/** The first of `ids` the product has, e.g. power on an EccoFlow, status elsewhere. */
export function firstTrait(traits: Traits, ...ids: string[]): DeviceTrait | undefined {
  for (const id of ids) {
    const trait = traits.get(id);
    if (trait) return trait;
  }
  return undefined;
}

function schemaOf(trait: DeviceTrait): ValueSchema {
  return trait.value_schema ?? {};
}

/** { property, min, max } when the trait is an object with a single bounded number. */
export function numericProperty(trait: DeviceTrait): { property: string; min: number; max: number } | null {
  const props = Object.entries(schemaOf(trait).properties ?? {});
  if (props.length !== 1) return null;

  const [property, spec] = props[0];
  if (spec.type !== 'integer' && spec.type !== 'number') return null;
  if (spec.minimum === undefined || spec.maximum === undefined) return null;
  return { property, min: spec.minimum, max: spec.maximum };
}

/** Enum values, whether declared on the trait itself or on its single property. */
export function enumValues(trait: DeviceTrait): (string | number)[] {
  const schema = schemaOf(trait);
  if (schema.enum?.length) return schema.enum;
  for (const prop of Object.values(schema.properties ?? {})) {
    if (prop.enum?.length) return prop.enum;
  }
  return [];
}

/**
 * The (on, off) values an on/off trait expects, or null when the schema does
 * not describe a switch. Writable controls are only offered where the schema
 * is clear, so nothing is ever sent that cannot be validated.
 */
export function onOffValues(trait: DeviceTrait): [unknown, unknown] | null {
  const schema = schemaOf(trait);
  if (schema.type === 'boolean') return [true, false];

  const values = schema.enum;
  if (!values?.length) return null;
  if (values.length === 2 && values.includes(0) && values.includes(1)) return [1, 0];
  if (values.includes('on') && values.includes('off')) return ['on', 'off'];
  return null;
}

/**
 * Encode a value the way the device reports it. The catalogue often declares
 * an object where the device actually uses a plain scalar (verified upstream
 * on HeliaLux brightness and SmartFeed feed_quantity / led_switch), so mirror
 * what was read instead of trusting the schema.
 */
export function encode(current: unknown, target: unknown, property: string | null): unknown {
  if (current !== null && typeof current === 'object' && !Array.isArray(current) && property) {
    return { ...current, [property]: target };
  }
  return target;
}

/** A reported value as a scalar: objects with a single field are unwrapped. */
export function unwrap(value: unknown, property?: string): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (property !== undefined && property in record) return record[property];
  const values = Object.values(record);
  return values.length === 1 ? values[0] : undefined;
}

/** A reported value as a finite number, or null. */
export function toNumber(value: unknown, property?: string): number | null {
  const raw = unwrap(value, property);
  if (raw === undefined || raw === null || raw === '' || typeof raw === 'boolean') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
