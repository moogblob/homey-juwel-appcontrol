/**
 * Public types for the MyJUWEL / qconnex cloud API.
 *
 * The cloud API is undocumented. These interfaces only pin down the fields
 * known from the Python integration at
 * https://github.com/Melle79/juwel-appcontrol; everything else is kept open
 * via index signatures and should be tightened as real responses are observed.
 */

export interface JuwelCloudOptions {
  email: string;
  password: string;
  /** Override the API host, e.g. for testing. */
  host?: string;
}

/** Fields set on a device via POST /device/{id}/state, keyed by trait msg_key. */
export type StatePayload = Record<string, unknown>;

export type PresetCommand =
  | { type: 'preset'; action: 'pause'; timeout: number }
  | { type: 'preset'; action: 'resume' }
  | { type: 'preset'; action: 'set'; id: number | string; dayOfWeek: number };

export type CommandBody = PresetCommand | Record<string, unknown>;

/** Colour channel values in percent (0..100). */
export interface ChannelValues {
  red: number;
  green: number;
  blue: number;
  white: number;
}

export interface CloudEffect {
  speed: number;
  intensity: number;
}

/** One point on a profile's daily curve. Observed from GET /presets. */
export interface TimeEvent {
  /** Minutes after midnight, 0..1439. */
  time: number;
  cloud: CloudEffect;
  value: ChannelValues;
}

/**
 * A lighting profile including its daily curve. Observed from GET /presets.
 * Vendor presets have numeric-string ids ('0'..'4'); user presets have random ids.
 */
export interface Preset {
  id: string;
  name: string;
  type: 'vendor' | 'user';
  /** Hex colour used by the app for the profile chip, e.g. "#B5D4E3". */
  color: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
  timeEvents: TimeEvent[];
}

/** One feeding on a feeder plan. Observed from GET /presets/feeder. */
export interface FeederTimeEvent {
  id: number;
  /** Minutes after midnight, 0..1439. */
  time: number;
  /** Feed amount, 1..8 per the upstream integration. */
  value: { amount: number };
  /** Weekdays as a list (0 = Sunday .. 6 = Saturday); absent on the vendor plan. */
  weekDays?: number[];
}

/**
 * A feeding plan. Observed from GET /presets/feeder (vendor plan only, no
 * SmartFeed on the account). Create or overwrite with POST /presets/feeder
 * using a single plan as body; the cloud answers 204.
 */
export interface FeederPreset {
  id: string;
  name: string;
  type: 'vendor' | 'user';
  color: string;
  createdAt?: string;
  timeEvents: FeederTimeEvent[];
  /** Cron-like day pattern, '* * *' on the vendor plan. Meaning of the three fields unverified. */
  commandInterval: string;
}

/** Which preset is active on which weekday (0 = Sunday .. 6 = Saturday). */
export interface TimelineEntry {
  id: string;
  dayOfWeek: number;
}

/** The device holds a few preset slots; slot 0 is the vendor default. */
export interface PresetSlotInfo {
  slotId: number;
  presetId: string;
}

export interface DeviceRef {
  productId: string;
  cloudDeviceId: string;
  localDeviceId: string;
}

/** A device as listed in GET /settings. Observed on a HeliaLux AppControl. */
export interface Device extends DeviceRef {
  name: string;
  ssid: string;
  /** Empty in /settings; use GET /device/{id}/state instead. */
  state: Record<string, unknown>;
  /** Device secret. Never log it. */
  aesKey: string;
  /** Device secret. Never log it. */
  accessToken: string;
  debugId: string;
  timeline: TimelineEntry[];
  /** POSIX TZ string, e.g. 'CET-1CEST,M3.5.0,M10.5.0/3'. */
  timezone: string;
  /** Unix epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
  syncedWith: unknown[];
  /** Preview (manual) mode: duration in ms, and the epoch-ms end time while a pause is active. */
  previewConfig: { duration: number; runningUntil?: number };
  manufacturerId: string;
  presetSlotInfo: PresetSlotInfo[];
  firmwareVersion: string;
  hardwareRevision: string;
  helialuxSpectrum?: string;
  onboardingComplete: boolean;
  isWifiSignalStrengthIndicatorVisible?: boolean;
  [key: string]: unknown;
}

export interface Room {
  id: string;
  icon: string;
  name: string;
  type: 'room';
  aquariums: unknown[];
}

export interface DeviceGroup {
  id: string;
  icon: string;
  name: string;
  type: 'aquarium' | string;
  color: string;
  devices: DeviceRef[];
}

/** Account settings from GET /settings. */
export interface Settings {
  rooms: Room[];
  timers: unknown[];
  devices: Device[];
  routines: unknown[];
  automations: unknown[];
  deviceGroups: DeviceGroup[];
  configuration: {
    ssid: string;
    /** e.g. 'de|en' */
    locale: string;
    isAlexaLinked: boolean;
  };
}

/** Loose JSON Schema fragment as used in trait value_schema. */
export interface ValueSchema {
  type?: string;
  /** Strings on most traits; some on/off traits use 0 / 1. */
  enum?: (string | number)[];
  minimum?: number;
  maximum?: number;
  properties?: Record<string, ValueSchema>;
  definitions?: Record<string, ValueSchema>;
  $ref?: string;
}

/** One capability of a product. `msg_key` is the field name in device state. */
export interface DeviceTrait {
  /** e.g. '@core/traits/status' */
  trait: string;
  msg_key: string;
  segment?: string;
  value_schema: ValueSchema;
}

export interface Widget {
  widget: string;
  traits: string[];
  category: 'homescreen' | 'detailscreen' | string;
  version?: number;
  properties: Record<string, unknown>;
}

/** GET /config/product/{productId}. Observed for @juwel.lighting.helialux1. */
export interface ProductConfig {
  id: string;
  createdAt: string;
  updatedAt: string;
  schemaVersion: number;
  productId: string;
  configVersion: number;
  brandId: string;
  deviceTypeId: 'light' | string;
  assets: Record<string, unknown>;
  segments: string[];
  transport: { type: string; topic: string; msg_type: string };
  deviceTraits: DeviceTrait[];
  widgets: Widget[];
  manufacturerId: string;
}

/**
 * HeliaLux state as reported by GET /device/{id}/state while connected.
 * Observed on firmware V2.0.1.3. Only 6 of these fields are declared in the
 * product catalogue (status, brightness, color, white, mode, connectivity);
 * the rest are undocumented device fields. Colour and white use 0..255,
 * brightness 0..100.
 */
export interface HeliaLuxState {
  status?: 'on' | 'off';
  /**
   * NOTE: in 'auto' mode the device does not report live values. brightness,
   * color and white stay frozen at the last manual value while the lamp
   * follows the profile curve; compute the current value from the active
   * Preset's timeEvents instead. Verified on hardware 2026-09-28.
   */
  brightness?: { percentage: number };
  color?: { red: number; green: number; blue: number };
  white?: { value: number };
  /** 'auto' while the schedule runs, 'rgb' during a manual override (preview). */
  mode?: 'auto' | 'rgb';
  connectivity?: { value: 'OK' | 'UNREACHABLE' };

  // --- undocumented device fields ---------------------------------------
  /** Slot index of the running profile, see Device.presetSlotInfo. */
  active_preset?: number;
  /** 65535 when idle. */
  active_command?: number;
  active_scene?: string;
  fade?: { in: number; out: number };
  fwversion?: string;
  sdkversion?: string;
  /** Unix epoch seconds of the device's last report. */
  last_update?: number;
  open_slots?: number;
  power_on?: number;
  preset_count?: number;
  /** Slot index per weekday, index 0 = Sunday .. 6 = Saturday. */
  preset_id_by_weekday?: number[];
  /** Profiles stored on the device. `name` is the cloud preset id. */
  presets?: { id: number; name: string; datapoints: number }[];
  /** True while a manual override (pause) is active. */
  preview?: boolean;
  reset_reason?: number;
  service?: boolean;
  /** Seconds left of the manual override; 0 when the schedule runs. */
  timeout?: number;
  type?: 'status' | string;
}

/**
 * Manual light values, all in percent (0..100) like the Preset timeEvents.
 * Omitted fields are left unchanged on the device. The client converts to
 * the cloud's wire scales (colour and white 0..255) internally.
 */
export interface ManualLightOptions {
  status?: 'on' | 'off';
  /** Master dimmer over all four channels, 0..100. */
  brightness?: number;
  /**
   * Per-channel levels, 0..100 each. The cloud writes red/green/blue as one
   * object, so a partial red/green/blue update is completed from the current
   * device state before sending.
   */
  channels?: Partial<ChannelValues>;
}

/**
 * GET /device/{id}/state. Observed while the device was offline, where only
 * the envelope below is returned. When connected the cloud adds trait values
 * keyed by msg_key (status, brightness, color, white, ...); capture a
 * connected response to tighten these.
 */
export interface DeviceState extends HeliaLuxState {
  id: string;
  connected: boolean;
  /** ISO 8601; the epoch '1970-01-01T00:00:00.000Z' means never. */
  lastActivityTime: string;
  /** Traits not covered above, for other products. */
  [msgKey: string]: unknown;
}
