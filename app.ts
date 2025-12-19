import Homey from 'homey';

import { config } from './lib/config';

export default class MarstekBatteryContoller extends Homey.App {
  /**
     * onInit is called when the app is initialized.
     */
  async onInit() {
    this.log('MarstekBatteryAPI has been initialized');
    config.version = this.homey.manifest.version;
    config.isTestVersion = !this.homey.manifest.version.endsWith('.0');
    this.log(`DEBUG logging set to ${String(config.isTestVersion)} for version ${this.homey.manifest.version} and environment value ${process.env.DEBUG}`);
  }

  /**
     * This method is called when the app is destroyed
     */
  async onUninit() {
    this.log('MarstekBatteryAPI has been uninitialized');
  }
}

// Also use module.exports for Homey
module.exports = MarstekBatteryContoller;
