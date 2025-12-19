import { URL } from 'url';
import https from 'https';
import http from 'http';

import Homey from 'homey';

// Load homey config
import { config } from './config';

/**
 * @description Manages communication to the Marstek Cloud for authentication and device details retrieval.
 * @class
 */
export default class MarstekCloud {

    // Singleton promises during requests to prevent async double calls
    private loginPromise?: Promise<object> = undefined;
    private devicePromise?: Promise<object[]> = undefined;

    // Private properties
    private username?: string = undefined;
    private password?: string = undefined;
    private baseUrl: string = 'https://eu.hamedata.com';
    private logger: Console | Homey.Driver;
    private token?: string = undefined;
    private devices?: object[] = undefined;
    private lastDeviceStatus?: object[] = undefined;
    private debug: boolean = config.isTestVersion;
    private timestamp?: Date = undefined;

    /**
     * Creates a new MarstekSocket instance.
     * @constructor
     * @param {string} username The email address that is used to login to the Marstek Cloud
     * @param {string} password MD5 enrypted password for the Marstek Cloud account
     * @param {object} [parent] The Homey parent that is creating this class (for logging)
     */
    constructor(username: string, password: string, parent: Homey.Driver) {
      if (!username || !password) throw new Error('Username and (encrypted) password are required');
      this.username = username;
      this.password = password;
      this.logger = parent ?? console;
    }

    /**
     * Update the password in this instance, always use MD5 encoded string
     * @param {string} newPassword MD5 encoded password string
     */
    setPassword(newPassword: string) {
      this.password = newPassword;
    }

    /**
     * Authenticate with the Marstek cloud service.
     * use GET on URL: https://eu.hamedata.com/app/Solar/v2_get_device.php
        {
          code: '2',
          register_date: '2025-09-08 11:39:19',
          msg: '登录成功，已绑定设备',
          token: '7fe122488b71ffa36d9bce1e41dc755f',
          data: [
            {
              devid: '2834958029834958023',
              name: 'MST_ACCP_aaaa',
              sn: 'HCOUPLE50251703184',
              mac: 'acd628a75a93',
              type: 'HMG-50',
              access: '1',
              bluetooth_name: 'MST_ACCP_aaaa',
              date: '2025-09-08 11:49:52'
            }
          ]
        }
     */

    async login() {
      if (this.debug) this.logger.log('[cloud] Login request (for new token)');

      // make sure a single promise is active while logging in
      if (this.loginPromise) {
        if (this.debug) this.logger.log('[cloud] Login already being processed.');
        return this.loginPromise;
      }

      // singleton promise to catch multiple async logins
      this.loginPromise = (async () => {
        this.token = undefined;

        // Login is done by requesting devices using username and MD5 password
        try {
          if (this.debug) this.logger.log('[cloud] Starting request');
          const username = encodeURIComponent(this.username || ''); // escape for special characters like +
          const response = await this.request(`/app/Solar/v2_get_device.php?pwd=${this.password}&mailbox=${username}`);

          // Store received token
          if (response && response.token) {
            if (this.debug) this.logger.log('[cloud] New token received:', response.token);
            this.token = response.token;
          } else {
            throw new Error('Login did not return a token');
          }

          // Store the received devices
          if (response.data) {
            if (this.debug) this.logger.log('[cloud] New list of devices received:', JSON.stringify(response.data));
            this.devices = response.data;
            return response;
          }
          this.devices = undefined;
          throw new Error('Login did not return any devices.');

        } catch (err) {
          this.logger.error((err as Error).message || err);
          throw err;
        } finally {
          this.loginPromise = undefined;
        }
      })();

      return this.loginPromise;
    }

    /**
     * Retrieve all devices linked to the authenticated account.
     * @returns {Array<object>} array of devices retrieve during authentication
     */
    async fetchDevices() {
      return this.devices || [];
    }

    /**
     * Retrieve a status for all devices
     */
    async fetchDeviceStatus() {

      // make sure a single promise is active while logging in
      if (this.devicePromise !== undefined) {
        if (this.debug) this.logger.log('[cloud] Device status request already being processed.', this.devicePromise);
        return this.devicePromise;
      }

      // Check if last response is within cache (call outside promise due to concurrency)
      if (this.lastDeviceStatus && this.timestamp) {
        const now = new Date();
        const diff = (now.getTime() - this.timestamp.getTime());
        if (diff < 58000) {
          if (this.debug) this.logger.log('[cloud] Using cached device status response');
          return this.lastDeviceStatus;
        }
      }

      // Singleton promise to prevent multiple calls at same time
      this.devicePromise = (async () => {
        try {
          // Make sure a token is available
          if (!this.token) {
            if (this.debug) this.logger.log('[cloud] No token found, request a new token first');
            await this.login();
          }

          // Request latest device details
          if (this.debug) this.logger.log('[cloud] Main request of device list status.');
          let response = await this.requestDeviceList();

          // If response indicated token problems; make sure to login again
          if (response && response.code === '8') {
            if (this.debug) this.logger.log('[cloud] Token is (no longer) valid, refreshing token and retry device list call');
            await this.login();
            // Request latest device details (again)
            response = await this.requestDeviceList();
          }

          // Detect is device status is received
          if (!response || !response.data) {
            this.logger.error('[cloud] Incorrect response was received', response);
            throw new Error('[cloud] Incorrect response was received');
          }

          // Record the last successful received response
          this.timestamp = new Date();
          this.lastDeviceStatus = response.data;
          if (this.debug) this.logger.log('[cloud] Device status details received', JSON.stringify(response.data));

          // Resolve to received response
          return response.data;

        } catch (err) {
          this.logger.error('[cloud] Failed to fetch device status: ', (err as Error).message || err);
          if (err) throw err;
        } finally {
          this.devicePromise = undefined;
        }
        return undefined;
      })();

      return this.devicePromise;
    }

    /**
     * Helper function to retrieve device list from the Marstek cloud
     * @returns {Promise<any>}
     * Use GET on URL: https://eu.hamedata.com/ems/api/v1/getDeviceList?token=<TOKEN>
     *  {
          "timeZone": "Europe/Amsterdam",
          "devid": "2834958029834958023",
          "name": "MST_ACCP_aaaa",
          "mac": "acd628a75a93",
          "type": "HMG-50",
          "access": "1",
          "version": "153",
          "bluetooth_name": "MST_ACCP_aaaa",
          "sn": "HCOUPLE50651903294",
          "soc": 63,                    // State of Charge (%)
          "discharge": 0,               // Discharge Grid (Watt)
          "charge": 1993,               // Charge Grid (Watt)
          "load": 0,                    // Unknown
          "profit": "0.00",             // Profit
          "pv": -1993,                  // Unknown (Watt)
          "report_time": 1759403159,    // Last update received (epoch)
          "salt": "0,ab32caea00126c7b",
          "is_support": 1,
          "status": 1
        }
     */
    async requestDeviceList() {
      // Request latest device details (again)
      return await this.request(`/ems/api/v1/getDeviceList?token=${this.token}`);
    }

    /**
     * Execute a HTTP request against the Marstek cloud API.
     * @param {string} path Path to call (exclude hostname and protocol)
     * @param {string} [method] HTTP method (default to GET)
     * @returns {Promise<any>} resolved when request is completed and return the JSON data received as parsed object
     */
    async request(path: string, method: string = 'GET'): Promise<any> {
      if (!path) throw new Error('A path is required');
      const url = new URL(path, this.baseUrl);
      const httpModule = url.protocol === 'https:' ? https : http;

      return new Promise((resolve, reject) => {
        const request = {
          method,
          protocol: url.protocol,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          headers: { Accept: 'application/json' },
        };
        const req = httpModule.request(request, (res) => {
          let data = '';
          res.on('data', (chunk) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              // Incorrect http status received
              if (res.statusCode && res.statusCode >= 400) {
                throw new Error(`Incorrect HTTP status code received: ${res.statusCode}`);
              }
              // Empty response
              if (!data) {
                this.logger.error('[cloud] Empty response received');
                return resolve(undefined);
              }
              // Finally parse and resolve
              const parsed = JSON.parse(data);
              resolve(parsed);
              return parsed;
            } catch (err) {
              this.logger.error('Exception during request: ', (err as Error).message || err);
              reject(err);
            }
          });
        });
        req.on('error', reject);
        req.end();
      });
    }

}
