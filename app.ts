import Homey from 'homey';

import { config } from './lib/config';

export default class MarstekBatteryContoller extends Homey.App {
  /**
     * onInit is called when the app is initialized.
     */
  async onInit() {
    if (this.debug) {
      this.log('MarstekBatteryAPI has been initialized');
    }
    config.version = this.homey.manifest.version;
    config.isTestVersion = !this.homey.manifest.version.endsWith('.0');
    if (this.debug) {
      this.log(`DEBUG logging set to ${String(config.isTestVersion)} for version ${this.homey.manifest.version} and environment value ${process.env.DEBUG}`);
    }

    // Register flow action for resetting statistics
    this.homey.flow
      .getActionCard('reset_statistics')
      .registerRunListener(async ({ device }) => {
        await device.resetStatistics();
      });
  }

  /**
     * This method is called when the app is destroyed
     */
  async onUninit() {
    if (this.debug) {
      this.log('MarstekBatteryAPI has been uninitialized');
    }
  }

  get debug(): boolean {
    return config.isTestVersion;
  }
}

// Also use module.exports for Homey
module.exports = MarstekBatteryContoller;
