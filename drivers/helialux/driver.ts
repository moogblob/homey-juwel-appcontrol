import Homey from 'homey';
import type JuwelApp from '../../app.js';

/**
 * Product id prefix the MyJUWEL cloud uses for lamps, e.g.
 * "@juwel.lighting.helialux1".
 */
const LIGHTING_PRODUCT_PREFIX = '@juwel.lighting.';

export default class HeliaLuxDriver extends Homey.Driver {

  async onInit() {
    this.log('HeliaLux driver has been initialized');
  }

  /**
   * Lists the HeliaLux lamps on the MyJUWEL account. Only the cloud device id
   * and product id are kept: the account payload also carries the device's
   * aesKey and accessToken, which are secrets and must not be stored here.
   * Every lamp is named "HeliaLux": the MyJUWEL name carries an "App-Control"
   * suffix.
   */
  async onPairListDevices() {
    const app = this.homey.app as JuwelApp;
    const settings = await app.getCloud().getSettings();

    return (settings.devices ?? [])
      .filter((device) => device.productId?.startsWith(LIGHTING_PRODUCT_PREFIX))
      .map((device) => ({
        name: 'HeliaLux',
        data: { id: device.cloudDeviceId },
        store: { productId: device.productId },
      }));
  }

}
