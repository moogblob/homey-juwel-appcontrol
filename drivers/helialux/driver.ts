import Homey from 'homey';
import type JuwelApp from '../../app.js';
import { normalizeUnitId } from '../../lib/juwel/local.js';

/**
 * Product id prefix the MyJUWEL cloud uses for lamps, e.g.
 * "@juwel.lighting.helialux1".
 */
const LIGHTING_PRODUCT_PREFIX = '@juwel.lighting.';

/**
 * The MyJUWEL name without the "AppControl" / "App-Control" it adds, so
 * "HeliaLux AppControl 2" becomes "HeliaLux 2". Names the user chose in the
 * JUWEL app are kept as they are.
 */
function lampName(name: string | undefined): string {
  const cleaned = (name ?? '').replace(/\bapp[\s-]?control\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return cleaned || 'HeliaLux';
}

export default class HeliaLuxDriver extends Homey.Driver {

  async onInit() {
    this.log('HeliaLux driver has been initialized');
  }

  /**
   * Lists the HeliaLux lamps on the MyJUWEL account, named as in MyJUWEL so
   * several lamps can be told apart.
   *
   * This is the only cloud call: a lamp is identified by its unit id (its MAC
   * address) and controlled locally with its aesKey from then on.
   */
  async onPairListDevices() {
    const app = this.homey.app as JuwelApp;
    const settings = await app.getCloud().getSettings();

    return (settings.devices ?? [])
      .filter((device) => device.productId?.startsWith(LIGHTING_PRODUCT_PREFIX))
      .filter((device) => device.localDeviceId && device.aesKey)
      .map((device) => ({
        name: lampName(device.name),
        data: { id: normalizeUnitId(device.localDeviceId) },
        store: { productId: device.productId, aesKey: device.aesKey },
      }));
  }

}
