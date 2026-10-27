import Homey from 'homey';
import { JuwelCloud, type Preset, type ProductConfig } from './lib/juwel/client.js';

export const SETTING_USERNAME = 'username';
export const SETTING_PASSWORD = 'password';

/** How long lighting profiles are reused before an edit in the MyJUWEL app is picked up. */
const PRESETS_TTL_MS = 60 * 60 * 1000;

export type Credentials = {
  username: string;
  password: string;
};

export type PairDevice = {
  name: string;
  data: { id: string };
  store: { productId: string };
};

export default class JuwelApp extends Homey.App {

  private cloud: JuwelCloud | null = null;
  private productConfigs = new Map<string, Promise<ProductConfig>>();
  private presets: { fetchedAt: number; list: Promise<Preset[]> } | null = null;

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('JUWEL has been initialized');

    this.homey.settings.on('set', (key: string) => this.onSettingsChanged(key));
    this.homey.settings.on('unset', (key: string) => this.onSettingsChanged(key));

    if (this.getCredentials() === null) {
      this.log('No MyJUWEL credentials configured, please add them in the app settings');
    }
  }

  /**
   * Returns the MyJUWEL credentials entered in the app settings,
   * or null when they have not been filled in (completely) yet.
   */
  getCredentials(): Credentials | null {
    const username = this.homey.settings.get(SETTING_USERNAME);
    const password = this.homey.settings.get(SETTING_PASSWORD);

    if (typeof username !== 'string' || typeof password !== 'string') return null;
    if (username.trim() === '' || password === '') return null;

    return { username: username.trim(), password };
  }

  /**
   * The shared MyJUWEL cloud client, built lazily from the app settings and
   * reused by every driver and device so they share one session and token.
   * Throws when no credentials have been entered yet.
   */
  getCloud(): JuwelCloud {
    const credentials = this.getCredentials();
    if (credentials === null) {
      throw new Error(this.homey.__('error.no_credentials'));
    }

    if (this.cloud === null) {
      this.cloud = new JuwelCloud({
        email: credentials.username,
        password: credentials.password,
      });
    }

    return this.cloud;
  }

  /**
   * The product catalogue entry (traits with msg_key and value schema) for a
   * product id. It does not change at runtime, so it is fetched once per
   * product; a failed fetch is forgotten so the next call retries.
   */
  getProductConfig(productId: string): Promise<ProductConfig> {
    let config = this.productConfigs.get(productId);
    if (config === undefined) {
      config = this.getCloud().getProductConfig(productId);
      config.catch(() => this.productConfigs.delete(productId));
      this.productConfigs.set(productId, config);
    }
    return config;
  }

  /**
   * A lighting profile with its daily curve, by cloud preset id. Profiles are
   * shared by every lamp on the account and change rarely, so the list is
   * reused for PRESETS_TTL_MS, or refetched sooner when `id` is not in it.
   */
  async getPreset(id: string): Promise<Preset | null> {
    const cache = this.presets;
    if (cache !== null && Date.now() - cache.fetchedAt < PRESETS_TTL_MS) {
      const cached = (await cache.list.catch((): Preset[] => [])).find((p) => p.id === id);
      if (cached) return cached;
    }

    const list = this.getCloud().getPresets();
    this.presets = { fetchedAt: Date.now(), list };
    list.catch(() => {
      if (this.presets?.list === list) this.presets = null;
    });
    return (await list).find((p) => p.id === id) ?? null;
  }

  /**
   * Lists the account's devices whose catalogue type is one of
   * `deviceTypeIds` ('light', 'feeder', 'eccoflow', ...). Only the cloud device id and product id
   * are kept: the account payload also carries the device's aesKey and
   * accessToken, which are secrets and must not be stored in Homey. Every
   * device is named `name`: the MyJUWEL names carry an "App-Control" suffix.
   */
  async listDevicesOfType(deviceTypeIds: string[], name: string): Promise<PairDevice[]> {
    const settings = await this.getCloud().getSettings();
    const result: PairDevice[] = [];

    for (const device of settings.devices ?? []) {
      if (!device.cloudDeviceId || !device.productId) continue;

      let config: ProductConfig;
      try {
        config = await this.getProductConfig(device.productId);
      } catch (err) {
        this.error(`Could not read the product catalogue for ${device.productId}:`, err);
        continue;
      }
      if (!deviceTypeIds.includes(config?.deviceTypeId)) continue;

      result.push({
        name,
        data: { id: device.cloudDeviceId },
        store: { productId: device.productId },
      });
    }

    return result;
  }

  private onSettingsChanged(key: string) {
    if (key !== SETTING_USERNAME && key !== SETTING_PASSWORD) return;

    // Drop the cached client so the next call logs in with the new credentials.
    this.cloud = null;
    this.productConfigs.clear();
    this.presets = null;
    this.log(`MyJUWEL credentials changed (${key})`);
  }

}
