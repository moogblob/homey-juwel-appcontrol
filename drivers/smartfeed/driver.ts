import Homey from 'homey';
import type JuwelApp from '../../app.js';
import type SmartFeedDevice from './device.js';

export default class SmartFeedDriver extends Homey.Driver {

  async onInit() {
    this.homey.flow.getActionCard('smartfeed_feed')
      .registerRunListener(({ device, amount }: { device: SmartFeedDevice; amount: number }) => device.feed(amount));

    this.homey.flow.getActionCard('smartfeed_feed_default')
      .registerRunListener(({ device }: { device: SmartFeedDevice }) => device.feed());

    this.log('SmartFeed driver has been initialized');
  }

  /** Lists the feeders (catalogue type "feeder") on the MyJUWEL account. */
  async onPairListDevices() {
    return (this.homey.app as JuwelApp).listDevicesOfType(['feeder'], 'SmartFeed');
  }

}
