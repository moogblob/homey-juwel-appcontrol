import Homey from 'homey';

export const SETTING_USERNAME = 'username';
export const SETTING_PASSWORD = 'password';

export type Credentials = {
  username: string;
  password: string;
};

export default class MyApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   */
  async onInit() {
    this.log('MyApp has been initialized');

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

  private onSettingsChanged(key: string) {
    if (key !== SETTING_USERNAME && key !== SETTING_PASSWORD) return;
    this.log(`MyJUWEL credentials changed (${key})`);
  }

}
