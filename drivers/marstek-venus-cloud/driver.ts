import Homey from 'homey';
import crypto from 'crypto';

// Use require for esModule class instances
import MarstekCloud from '../../lib/marstek-cloud';

/**
 * Driver for Marstek Venus devices connected via the Marstek cloud service.
 * Manages pairing, credential reuse and provides access to shared cloud clients.
 * @extends Homey.Driver
 */
export default class MarstekVenusCloudDriver extends Homey.Driver {

    // Private properties
    private pairSessions: Map<any, any> = new Map();
    private clients: Map<string, MarstekCloud> = new Map();
    private debug: boolean = (this.homey.manifest.version.endsWith('.0') === false || !!process.env.DEBUG);

    /**
     * Called when the driver is initialised.
     * Prepares state for pairing sessions and client caching.
     * @returns {Promise<void>} Resolves when initialisation completes.
     */
    async onInit() {
      if (this.debug) this.log('MarstekVenusCloudDriver has been initialized');
      await this.registerFlowListeners();
    }

    /**
     * Registers listeners for the flow action cards supplied by the driver.
     * @returns {Promise<void>} Resolves once the listeners are registered.
     */
    async registerFlowListeners(): Promise<void> {
      // Inline function to register handlers
      const register = (id: string, handler: Function) => {
        try {
          const card = this.homey.flow.getActionCard(id);
          card.registerRunListener(async (args: any) => {
            await handler(args);
            return true;
          });
          if (this.debug) this.log(`Successfully registered flow card: ${id}`);
        } catch (err) {
          this.error(`Failed to register flow card ${id}:`, err);
        }
      };

      // Register the energy price flow card action
      register(
        'cloud_set_energy_price',
        async ({
          device,
          price,
        }: {
                device: Homey.Device,
                price: number,
            }) => this.setEnergyPrice(device, price),
      );
      register(
        'verify_calculation',
        async ({
          device,
          timePeriod,
          includeDetails,
        }: {
                device: Homey.Device,
                timePeriod: string,
                includeDetails: boolean,
            }) => (device as any).verifyCalculation(timePeriod, includeDetails),
      );
    }

    /**
     * Called when the driver is uninitialised by Homey.
     * Clears any cached sessions and clients to free resources.
     * @returns {Promise<void>} Resolves once cleanup completes.
     */
    async onUninit() {
      if (this.debug) this.log('MarstekVenusCloudDriver has been uninitialized');
      this.pairSessions.clear();
      this.clients.clear();
    }

    /**
     * Handles a pairing session for the cloud driver.
     * Sets up handlers for login, device listing and session teardown.
     * @param {Object} session The pairing session provided by Homey.
     * @returns {Promise<void>} Resolves once handlers have been registered.
     */
    async onPair(session: Homey.Driver.PairSession) {
      this.pairSessions.set(session, {});

      session.setHandler('login', async ({ username, password }) => {
        // Make sure to encode password immediately
        const credentials = {
          username: username?.trim(),
          password: this.encode(password),
        };
        if (!credentials.username || !credentials.password) {
          throw new Error('Please enter both username and password');
        }

        // Create a cloud client instance and store details into session (for other discovered devices)
        const client = this.getClient(credentials);
        try {
          if (this.debug) this.log('[cloud] Login during pairing; always request a new token');
          await client?.login();
        } catch (err) {
          this.error('[cloud] Login failed:', (err as Error).message || err);
          return false;
        }
        this.pairSessions.set(session, { credentials, client });
        return true;
      });

      session.setHandler('list_devices', async () => {
        const state = this.pairSessions.get(session);
        if (!state || !state.client) throw new Error('Not authenticated');
        const devices = await state.client.fetchDevices();
        if (!devices || devices.length === 0) {
          throw new Error('No devices were returned by the Marstek cloud account');
        }

        // Map received devices into known format
        return devices.map((device: any) => ({
          name: device.name,
          data: {
            id: device.devid,
          },
          store: {
            username: state.credentials.username,
            password: state.credentials.password,
            name: device.name,
            type: device.type,
            devid: device.devid,
          },
          settings: {
            username: state.credentials.username,
            type: device.type || '(unknown)',
          },
        }));
      });

      session.setHandler('disconnect', async () => {
        this.pairSessions.delete(session);
      });
    }

    /**
     * Retrieves or creates a cached Marstek cloud client for the provided credentials.
     * @param {{ username: string, password: string }} credentials Cloud account credentials.
     * @returns {MarstekCloud|null} The cached client instance or a newly created one.
     */
    getClient(credentials: { username?: string, password?: string }) {
      // Check if username and password are given
      if (!credentials.username || !credentials.password) {
        throw new Error('Please enter both username and password');
      }

      // Check if there already a client
      const client = this.clients.get(credentials.username);
      if (!client) {
        if (this.debug) this.log('[cloud] Client not found, create new instance with stored credentials.');
        const newClient = new MarstekCloud(
          credentials.username,
          credentials.password,
          this, // pass our Homey Driver object for logging method access
        );
        this.clients.set(credentials.username, newClient);
        return newClient;
      }
      if (this.debug) this.log('[cloud] Using available instance of client.');
      client.setPassword(credentials.password);
      return client;

    }

    /**
     * Encodes a plain-text password using MD5 hashing as required by the Marstek cloud API.
     * @param {string} password Plain-text password to encode.
     * @returns {string} The hashed password string.
     */
    encode(password: string) {
      return crypto.createHash('md5').update(password).digest('hex');
    }

    /**
     * Sets the energy price per kWh for a device.
     * @param {Homey.device} device - Target device instance.
     * @param {number} price - Energy price in €/kWh.
     * @returns {Promise<void>} Resolves once the setting is updated.
     */
    async setEnergyPrice(device: Homey.Device, price: number) {
      if (typeof price !== 'number' || Number.isNaN(price) || price < 0) {
        throw new Error('Price must be a non-negative number');
      }
      await device.setSettings({ price_per_kwh: price });
    }

}

// Also use module.exports for Homey
module.exports = MarstekVenusCloudDriver;
