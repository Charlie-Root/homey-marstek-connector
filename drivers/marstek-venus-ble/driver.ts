import Homey from 'homey';

import { config } from '../../lib/config';
import {
    SERVICE_UUID,
    SHORT,
    Command,
    buildFrame,
    parseFrame,
    FrameReassembler,
    parseRuntimeInfo,
    parseBmsData,
    parseDeviceInfo,
    powerLimitPayload,
    localApiPayload,
    dodPayload,
    onOffPayload,
    systemResetPayload,
    RuntimeInfo,
    BmsData,
    DeviceInfo,
} from '../../lib/marstek-ble';

/** Result of a single BLE poll cycle; each field is present only if its read succeeded. */
export interface PollResult {
    runtime?: RuntimeInfo;
    bms?: BmsData;
    deviceInfo?: DeviceInfo;
}

/** Context handed to {@link MarstekVenusBleDriver#connectAndRun} callbacks. */
interface BleContext {
    /** Sends a command and waits for the response frame with the same command byte. */
    sendAndWait: (cmd: number, payload?: number[], timeout?: number) => Promise<Buffer>;
    /** Sends a command without waiting for any response. */
    send: (cmd: number, payload?: number[]) => Promise<void>;
}

// Time limits for the individual connection steps, so a hung step cannot block the queue.
const CONNECT_TIMEOUT = 15000;
const DISCOVER_TIMEOUT = 15000;
const SUBSCRIBE_TIMEOUT = 10000;

// Waits before each retry of a failed connection attempt (one entry per retry).
const RETRY_DELAYS = [2000, 5000];

/**
 * Driver for Marstek Venus batteries communicating over Bluetooth Low Energy.
 * Handles BLE discovery during pairing, background polling and flow action cards.
 * @extends Homey.Driver
 */
export default class MarstekVenusBleDriver extends Homey.Driver {

    // Add extra details during debugging
    private debug: boolean = config.isTestVersion;

    // Queue of BLE operations; the battery accepts one connection at a time, so they run one by one.
    private queue: Promise<unknown> = Promise.resolve();

    // Last advertisement that led to a successful connection, per peripheral UUID.
    private advertisements: Map<string, any> = new Map();

    /**
     * Called when the driver is initialised. Registers the flow action listeners.
     * @returns {Promise<void>} Resolves once initialisation completes.
     */
    async onInit() {
        if (this.debug) this.log('MarstekVenusBleDriver has been initialized');
        await this.registerFlowListeners();
    }

    /**
     * Handles pairing by discovering nearby Marstek batteries over BLE.
     * @param {Homey.Driver.PairSession} session Active pairing session.
     * @returns {Promise<void>} Resolves once the handlers are registered.
     */
    async onPair(session: Homey.Driver.PairSession): Promise<void> {
        session.setHandler('list_devices', async () => this.discoverDevices());
    }

    /**
     * Discovers Marstek batteries advertising the FF00 service over BLE.
     * @returns {Promise<Array<object>>} Devices formatted for the Homey pairing list.
     */
    async discoverDevices(): Promise<Array<any>> {
        if (!this.homey.ble) throw new Error('Bluetooth is not available on this Homey.');

        const advertisements = await this.homey.ble.discover();
        if (this.debug) this.log(`BLE discover found ${advertisements.length} advertisement(s)`);

        const isMarstek = (ad: any): boolean => {
            const hasService = Array.isArray(ad.serviceUuids)
                && ad.serviceUuids.some((u: string) => u.toLowerCase().includes(SHORT.service));
            const name = (ad.localName || '').toString();
            const nameMatches = /^(mst|marstek|hm|venus)/i.test(name);
            return ad.connectable !== false && (hasService || nameMatches);
        };

        return advertisements
            .filter(isMarstek)
            .map((ad: any) => ({
                name: ad.localName || `Marstek ${ad.address || ad.uuid}`,
                data: {
                    id: ad.uuid,
                },
                store: {
                    peripheralUuid: ad.uuid,
                    address: ad.address,
                },
                settings: {
                    poll: true,
                    interval: 60,
                    mac: ad.address || '(unknown)',
                },
            }));
    }

    /**
     * Reads the peripheral UUID stored for a device.
     * @param {Homey.Device} device Target device.
     * @returns {string} The peripheral UUID.
     */
    getPeripheralUuid(device: Homey.Device): string {
        const uuid = device.getStoreValue('peripheralUuid') || (device.getData() as any).id;
        if (!uuid) throw new Error('Device has no Bluetooth peripheral UUID.');
        return uuid;
    }

    /**
     * Runs the supplied callback while connected to a peripheral. Operations are queued so
     * only one BLE connection is active at a time across all devices. Setting up the
     * connection is retried with a short backoff; the callback itself runs only once.
     * @param {string} peripheralUuid UUID of the peripheral to connect to.
     * @param {(ctx: BleContext) => Promise<T>} fn Work to perform while connected.
     * @returns {Promise<T>} The callback's result.
     */
    async connectAndRun<T>(peripheralUuid: string, fn: (ctx: BleContext) => Promise<T>): Promise<T> {
        if (!this.homey.ble) throw new Error('Bluetooth is not available on this Homey.');

        const run = this.queue.then(() => this.connectWithRetry(peripheralUuid, fn));
        // Keep the queue going regardless of the outcome of this operation.
        this.queue = run.catch(() => undefined);
        return run;
    }

    /**
     * Connects (with retries) and runs the callback. Must only be called from the queue.
     * @param {string} peripheralUuid UUID of the peripheral to connect to.
     * @param {(ctx: BleContext) => Promise<T>} fn Work to perform while connected.
     * @returns {Promise<T>} The callback's result.
     */
    private async connectWithRetry<T>(peripheralUuid: string, fn: (ctx: BleContext) => Promise<T>): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            // Reuse the last known advertisement first; scan again when retrying.
            const freshScan = attempt > 0 || !this.advertisements.has(peripheralUuid);
            let connection: { peripheral: any, ctx: BleContext };
            try {
                connection = await this.openConnection(peripheralUuid, freshScan);
            } catch (err) {
                if (attempt >= RETRY_DELAYS.length) throw err;
                const delay = RETRY_DELAYS[attempt];
                if (this.debug) this.log(`BLE connect attempt ${attempt + 1} failed (${(err as Error).message}), retrying in ${delay} ms`);
                await new Promise<void>((resolve) => this.homey.setTimeout(resolve, delay));
                continue;
            }

            try {
                return await fn(connection.ctx);
            } finally {
                await this.closeConnection(connection.peripheral);
            }
        }
    }

    /**
     * Connects to a peripheral, discovers the FF00 service characteristics and subscribes to
     * notifications. Each step has a time limit; on failure the connection is closed again.
     * @param {string} peripheralUuid UUID of the peripheral to connect to.
     * @param {boolean} freshScan Whether to scan for a new advertisement instead of reusing the last one.
     * @returns {Promise<{peripheral: any, ctx: BleContext}>} The connected peripheral and a command helper.
     */
    private async openConnection(peripheralUuid: string, freshScan: boolean): Promise<{ peripheral: any, ctx: BleContext }> {
        const advertisement = freshScan
            ? await this.resolveAdvertisement(peripheralUuid)
            : this.advertisements.get(peripheralUuid);

        const connecting = advertisement.connect();
        let peripheral: any;
        try {
            peripheral = await this.withTimeout(connecting, CONNECT_TIMEOUT, 'Connecting to the battery');
        } catch (err) {
            // A connection that completes after the timeout must still be closed.
            connecting.then((late: any) => this.closeConnection(late)).catch(() => undefined);
            throw err;
        }

        try {
            // discoverAllServicesAndCharacteristics() returns the services; it does not reliably
            // populate peripheral.services, so use the returned array (with a fallback).
            const discovered = await this.withTimeout(
                peripheral.discoverAllServicesAndCharacteristics(),
                DISCOVER_TIMEOUT,
                'Discovering Bluetooth services',
            );
            const services = (Array.isArray(discovered) && discovered.length) ? discovered : (peripheral.services || []);

            const service = await this.findService(peripheral, services);
            const writeChar = await this.findCharacteristic(service, SHORT.write);
            const notifyChar = await this.findCharacteristic(service, SHORT.notify);

            const reassembler = new FrameReassembler();
            const waiters: Array<{ cmd: number; resolve: (b: Buffer) => void }> = [];

            await this.withTimeout(notifyChar.subscribeToNotifications((data: Buffer) => {
                for (const frame of reassembler.push(Buffer.from(data))) {
                    const parsed = parseFrame(frame);
                    if (!parsed) continue;
                    const idx = waiters.findIndex((w) => w.cmd === parsed.cmd);
                    if (idx >= 0) {
                        const [waiter] = waiters.splice(idx, 1);
                        waiter.resolve(parsed.payload);
                    }
                }
            }), SUBSCRIBE_TIMEOUT, 'Subscribing to battery notifications');

            const ctx: BleContext = {
                send: async (cmd: number, payload: number[] = []) => {
                    await writeChar.write(buildFrame(cmd, payload));
                },
                sendAndWait: (cmd: number, payload: number[] = [], timeout = 6000) => new Promise<Buffer>((resolve, reject) => {
                    const timer = this.homey.setTimeout(() => {
                        const idx = waiters.findIndex((w) => w.cmd === cmd);
                        if (idx >= 0) waiters.splice(idx, 1);
                        reject(new Error(`Timed out waiting for response to command 0x${cmd.toString(16)}`));
                    }, timeout);
                    waiters.push({
                        cmd,
                        resolve: (b: Buffer) => {
                            this.homey.clearTimeout(timer);
                            resolve(b);
                        },
                    });
                    writeChar.write(buildFrame(cmd, payload)).catch((err: Error) => {
                        this.homey.clearTimeout(timer);
                        const idx = waiters.findIndex((w) => w.cmd === cmd);
                        if (idx >= 0) waiters.splice(idx, 1);
                        reject(err);
                    });
                }),
            };

            this.advertisements.set(peripheralUuid, advertisement);
            return { peripheral, ctx };
        } catch (err) {
            await this.closeConnection(peripheral);
            throw err;
        }
    }

    /**
     * Disconnects a peripheral, ignoring errors (the connection may already be gone).
     * @param {any} peripheral Connected BLE peripheral.
     * @returns {Promise<void>} Resolves once the disconnect attempt finishes.
     */
    private async closeConnection(peripheral: any): Promise<void> {
        if (!peripheral) return;
        try {
            await peripheral.disconnect();
        } catch (err) {
            if (this.debug) this.error('Error while disconnecting:', err);
        }
    }

    /**
     * Rejects when the promise does not settle within the given time.
     * @param {Promise<T>} promise Promise to wait for.
     * @param {number} ms Time limit in milliseconds.
     * @param {string} step Description of the step, used in the error message.
     * @returns {Promise<T>} The promise's result.
     */
    private withTimeout<T>(promise: Promise<T>, ms: number, step: string): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            const timer = this.homey.setTimeout(() => reject(new Error(`${step} timed out after ${ms / 1000} s`)), ms);
            promise.then((value) => {
                this.homey.clearTimeout(timer);
                resolve(value);
            }, (err) => {
                this.homey.clearTimeout(timer);
                reject(err);
            });
        });
    }

    /**
     * Resolves an advertisement for the peripheral, preferring a fresh active scan over
     * {@link ManagerBLE#find}, which can return a stale/cached handle.
     * @param {string} peripheralUuid UUID of the peripheral to resolve.
     * @returns {Promise<any>} A BLE advertisement to connect to.
     */
    private async resolveAdvertisement(peripheralUuid: string): Promise<any> {
        try {
            const scanned = await this.homey.ble.discover();
            const ad = (scanned || []).find((a: any) => a.uuid === peripheralUuid);
            if (ad) {
                if (this.debug) this.log(`BLE peripheral found, rssi=${ad.rssi}`);
                return ad;
            }
        } catch (err) {
            if (this.debug) this.error('BLE scan failed:', (err as Error).message);
        }
        return this.homey.ble.find(peripheralUuid);
    }

    /**
     * Locates the FF00 service on a connected peripheral, tolerant of UUID formatting.
     * Falls back to {@link BlePeripheral#getService} and lists the discovered UUIDs on failure.
     * @param {any} peripheral Connected BLE peripheral.
     * @param {any[]} services Services returned by discovery.
     * @returns {Promise<any>} The matching service.
     */
    private async findService(peripheral: any, services: any[]): Promise<any> {
        let service = (services || []).find(
            (s: any) => (s.uuid || '').toLowerCase().includes(SHORT.service),
        );
        if (!service) {
            // Fallback: ask the peripheral directly (some Homey versions need this).
            try {
                service = await peripheral.getService(SERVICE_UUID);
            } catch (err) {
                if (this.debug) this.error('getService fallback failed:', (err as Error).message);
            }
        }
        if (!service) {
            const found = (services || []).map((s: any) => s.uuid).join(', ') || '(none)';
            throw new Error(`Battery does not expose the expected BLE service (${SERVICE_UUID}). `
                + `Discovered services: ${found}`);
        }
        return service;
    }

    /**
     * Locates a characteristic by its short (16-bit) identifier within a service.
     * Discovers the service's characteristics on demand if they are not yet populated.
     * @param {any} service BLE service.
     * @param {string} short Short characteristic identifier (e.g. `ff01`).
     * @returns {Promise<any>} The matching characteristic.
     */
    private async findCharacteristic(service: any, short: string): Promise<any> {
        let list = service.characteristics || [];
        if (!list.length && typeof service.discoverCharacteristics === 'function') {
            try {
                list = await service.discoverCharacteristics();
            } catch (err) {
                if (this.debug) this.error('discoverCharacteristics fallback failed:', (err as Error).message);
            }
        }
        const char = (list || []).find(
            (c: any) => (c.uuid || '').toLowerCase().includes(short),
        );
        if (!char) {
            const found = (list || []).map((c: any) => c.uuid).join(', ') || '(none)';
            throw new Error(`Battery is missing the expected BLE characteristic (${short}). Discovered characteristics: ${found}`);
        }
        return char;
    }

    /**
     * Performs a full read cycle (Runtime Info, BMS Data and Device Info). Individual reads
     * that fail are skipped; when nothing at all comes back the cycle is repeated once.
     * @param {string} peripheralUuid UUID of the peripheral to read.
     * @returns {Promise<PollResult>} The parsed telemetry that was successfully read.
     */
    async readAll(peripheralUuid: string): Promise<PollResult> {
        const result = await this.readOnce(peripheralUuid);
        if (result.runtime || result.bms) return result;
        if (this.debug) this.log('BLE read returned no data, retrying once with a fresh scan');
        this.advertisements.delete(peripheralUuid);
        return this.readOnce(peripheralUuid);
    }

    /**
     * Connects once and requests Runtime Info, BMS Data and Device Info.
     * @param {string} peripheralUuid UUID of the peripheral to read.
     * @returns {Promise<PollResult>} The parsed telemetry that was successfully read.
     */
    private async readOnce(peripheralUuid: string): Promise<PollResult> {
        return this.connectAndRun(peripheralUuid, async (ctx) => {
            const result: PollResult = {};

            try {
                result.runtime = parseRuntimeInfo(await ctx.sendAndWait(Command.RUNTIME_INFO));
            } catch (err) {
                if (this.debug) this.error('Runtime Info read failed:', (err as Error).message);
            }
            try {
                result.bms = parseBmsData(await ctx.sendAndWait(Command.BMS_DATA));
            } catch (err) {
                if (this.debug) this.error('BMS Data read failed:', (err as Error).message);
            }
            try {
                result.deviceInfo = parseDeviceInfo(await ctx.sendAndWait(Command.DEVICE_INFO));
            } catch (err) {
                if (this.debug) this.error('Device Info read failed:', (err as Error).message);
            }

            return result;
        });
    }

    /**
     * Sends a single command frame to a device (used by flow actions). Waits briefly for the
     * device's echoed response but treats a missing response as a successful fire-and-forget.
     * @param {Homey.Device} device Target device.
     * @param {number} cmd Command byte.
     * @param {number[]} [payload=[]] Command payload.
     * @returns {Promise<void>} Resolves once the command has been written.
     */
    async sendCommandToDevice(device: Homey.Device, cmd: number, payload: number[] = []): Promise<void> {
        const uuid = this.getPeripheralUuid(device);
        await this.connectAndRun(uuid, async (ctx) => {
            try {
                await ctx.sendAndWait(cmd, payload, 5000);
            } catch (err) {
                // No echo within the timeout — the command was still written; log and continue.
                if (this.debug) this.log(`No response echo for command 0x${cmd.toString(16)}:`, (err as Error).message);
            }
        });
    }

    /**
     * Registers listeners for all flow action cards.
     * @returns {Promise<void>} Resolves once the listeners are registered.
     */
    async registerFlowListeners(): Promise<void> {
        const register = (id: string, handler: (args: any) => Promise<void>) => {
            this.homey.flow.getActionCard(id).registerRunListener(async (args: any) => {
                await handler(args);
                return true;
            });
        };

        register('marstek_ble_work_mode', async ({ device, state }) => this.sendCommandToDevice(device, Command.WORK_MODE, onOffPayload(state === 'on')));
        register('marstek_ble_power_limit', async ({ device, level }) => this.sendCommandToDevice(device, Command.POWER_MODE, powerLimitPayload(Number(level))));
        register('marstek_ble_local_api', async ({ device, enable }) => this.sendCommandToDevice(device, Command.LOCAL_API, localApiPayload(!!enable)));
        register('marstek_ble_dod', async ({ device, percent }) => this.sendCommandToDevice(device, Command.DOD_SET, dodPayload(Number(percent))));
        register('marstek_ble_eps', async ({ device, enable }) => this.sendCommandToDevice(device, Command.BACKUP_POWER, onOffPayload(!!enable)));
        register('marstek_ble_system_reset', async ({ device }) => this.sendCommandToDevice(device, Command.SYSTEM_RESET, systemResetPayload()));
    }

}

// Also use module.exports for Homey
module.exports = MarstekVenusBleDriver;
