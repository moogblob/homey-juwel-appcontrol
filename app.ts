import Homey from 'homey';
import { JuwelCloud } from './lib/juwel/client.js';

export const SETTING_USERNAME = 'username';
export const SETTING_PASSWORD = 'password';

export type Credentials = {
  username: string;
  password: string;
};

export default class JuwelApp extends Homey.App {

  private cloud: JuwelCloud | null = null;

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('JUWEL AppControl has been initialized');

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

  private onSettingsChanged(key: string) {
    if (key !== SETTING_USERNAME && key !== SETTING_PASSWORD) return;

    // Drop the cached client so the next call logs in with the new credentials.
    this.cloud = null;
    this.log(`MyJUWEL credentials changed (${key})`);
  }

}
