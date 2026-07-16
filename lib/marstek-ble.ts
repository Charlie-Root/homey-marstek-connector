/**
 * @description Side-effect free helpers for the Marstek Venus "HM" BLE protocol.
 *
 * The protocol was reverse engineered by the community
 * (https://github.com/rweijnen/marstek-venus-monitor). Frames use the layout:
 *
 *   [0x73][LEN][0x23][CMD][...payload][XOR]
 *
 * where `LEN` is the total frame length (including the start byte and the
 * trailing checksum) and `XOR` is the exclusive-or of every byte in the frame
 * except the checksum byte itself (the start byte and length byte are
 * included). A rarely used "transition" variant encodes the length as a 16-bit
 * big-endian value: `[0x73][LEN_HI][LEN_LO][0x23][CMD][...payload][XOR]`.
 *
 * Responses are larger than the BLE MTU (~20 bytes) and therefore arrive
 * fragmented over several notifications. Use {@link FrameReassembler} to
 * recombine notification chunks into complete frames before parsing.
 *
 * @module lib/marstek-ble
 */

/** Primary GATT service exposed by the battery. */
export const SERVICE_UUID = '0000ff00-0000-1000-8000-00805f9b34fb';
/** Characteristic used to write commands to the battery. */
export const CHAR_WRITE_UUID = '0000ff01-0000-1000-8000-00805f9b34fb';
/** Characteristic that notifies command responses. */
export const CHAR_NOTIFY_UUID = '0000ff02-0000-1000-8000-00805f9b34fb';

/** Short (16-bit) identifiers, handy for substring matching regardless of UUID formatting. */
export const SHORT = {
    service: 'ff00',
    write: 'ff01',
    notify: 'ff02',
} as const;

const START_BYTE = 0x73;
const IDENTIFIER_BYTE = 0x23;

/** BLE command codes, taken from the reference project's actual command handlers
 * (`templates/*.html`), cross-checked against the `CommandType` enum in `types.ts`. */
export const Command = {
    // Read commands
    RUNTIME_INFO: 0x03,
    DEVICE_INFO: 0x04,
    BMS_DATA: 0x14,
    // Write commands
    WORK_MODE: 0x09, // work mode: 0 = Off, 1 = On
    BACKUP_POWER: 0x0f, // EPS / backup power: 1 = enable, 0 = disable
    SYSTEM_RESET: 0x0c, // restart the battery (fixed magic payload)
    POWER_MODE: 0x15, // output power limit (800 W / 2500 W)
    LOCAL_API: 0x28, // enable/disable Local UDP API + port
    DOD_SET: 0x54, // depth of discharge (30..88 %)
} as const;

/**
 * Computes the exclusive-or checksum over the supplied bytes.
 * @param {Uint8Array | number[]} bytes Bytes to reduce.
 * @returns {number} XOR checksum in the range 0..255.
 */
export function xorChecksum(bytes: Uint8Array | number[]): number {
    let cs = 0;
    for (const b of bytes) cs ^= b;
    return cs & 0xff;
}

/**
 * Builds a complete HM command frame ready to write to the FF01 characteristic.
 * @param {number} cmd Command byte (see {@link Command}).
 * @param {Uint8Array | number[]} [payload=[]] Optional command payload.
 * @returns {Buffer} The framed command including start byte, length and checksum.
 * @throws {Error} When the resulting frame is too large for the single-byte length field.
 */
export function buildFrame(cmd: number, payload: Uint8Array | number[] = []): Buffer {
    const p = Uint8Array.from(payload);
    const len = 5 + p.length; // 0x73 + LEN + 0x23 + CMD + payload + checksum
    if (len > 0xff) throw new Error(`Command frame too large: ${len} bytes`);
    const frame = Buffer.alloc(len);
    frame[0] = START_BYTE;
    frame[1] = len;
    frame[2] = IDENTIFIER_BYTE;
    frame[3] = cmd;
    frame.set(p, 4);
    frame[len - 1] = xorChecksum(frame.subarray(0, len - 1));
    return frame;
}

/** A validated, reassembled response frame. */
export interface ParsedFrame {
    /** Command byte the frame belongs to. */
    cmd: number;
    /** Payload bytes (everything after the command byte, excluding the checksum). */
    payload: Buffer;
}

/**
 * Validates a complete frame and extracts its command byte and payload.
 * The payload offset base matches the reference implementation: offset 0 is the
 * first byte after the command byte.
 * @param {Buffer} frame A single complete frame (as emitted by {@link FrameReassembler}).
 * @returns {ParsedFrame | null} The parsed frame, or `null` when the frame is malformed
 * or fails the checksum (the BLE Event Log command 0x13 skips checksum validation upstream).
 */
export function parseFrame(frame: Buffer): ParsedFrame | null {
    if (frame.length < 5 || frame[0] !== START_BYTE) return null;

    const normal = frame[2] === IDENTIFIER_BYTE;
    const transition = frame[3] === IDENTIFIER_BYTE;
    if (!normal && !transition) return null;

    // Verify checksum (XOR of all bytes except the trailing checksum byte).
    if (xorChecksum(frame.subarray(0, frame.length - 1)) !== frame[frame.length - 1]) {
        return null;
    }

    const cmd = normal ? frame[3] : frame[4];
    const payload = normal
        ? frame.subarray(4, frame.length - 1)
        : frame.subarray(5, frame.length - 1);

    return { cmd, payload: Buffer.from(payload) };
}

/**
 * Recombines fragmented BLE notification chunks into complete protocol frames.
 * Feed each notification buffer to {@link FrameReassembler#push}; it returns the
 * complete frames that became available (usually zero or one).
 */
export class FrameReassembler {

    private buffer: Buffer = Buffer.alloc(0);

    /**
     * Appends a notification chunk and returns any complete frames it produced.
     * @param {Buffer} chunk Raw notification payload.
     * @returns {Buffer[]} Zero or more complete frames.
     */
    push(chunk: Buffer): Buffer[] {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const frames: Buffer[] = [];

        while (this.buffer.length > 0) {
            // Resynchronise to the next start byte if needed.
            if (this.buffer[0] !== START_BYTE) {
                const idx = this.buffer.indexOf(START_BYTE);
                if (idx < 0) {
                    this.buffer = Buffer.alloc(0);
                    break;
                }
                this.buffer = this.buffer.subarray(idx);
            }

            // Need enough header bytes to determine the frame length.
            if (this.buffer.length < 4) break;

            let frameLen: number;
            if (this.buffer[2] === IDENTIFIER_BYTE) {
                frameLen = this.buffer[1]; // normal HM (single-byte length)
            } else if (this.buffer[3] === IDENTIFIER_BYTE) {
                frameLen = (this.buffer[1] << 8) | this.buffer[2]; // transition HM (16-bit BE)
            } else {
                // Not a valid marker after this start byte; skip it and resync.
                this.buffer = this.buffer.subarray(1);
                continue;
            }

            // Sanity guard against a corrupt length byte.
            if (frameLen < 5 || frameLen > 4096) {
                this.buffer = this.buffer.subarray(1);
                continue;
            }

            if (this.buffer.length < frameLen) break; // wait for the rest of the frame

            frames.push(Buffer.from(this.buffer.subarray(0, frameLen)));
            this.buffer = this.buffer.subarray(frameLen);
        }

        return frames;
    }

    /** Discards any buffered bytes (call before starting a new connection). */
    reset(): void {
        this.buffer = Buffer.alloc(0);
    }

}

// ---------------------------------------------------------------------------
// Payload parsers (offsets verified against firmware v155/v156 by the reference
// project). All offsets are relative to the payload, i.e. the byte after CMD.
// ---------------------------------------------------------------------------

/** Decoded fields from the Runtime Info response (command 0x03). */
export interface RuntimeInfo {
    /** Backup/EPS (off-grid) port power in W, signed — offset 0x00. The reference repo's type
     * names this "gridPower" but its UI labels it "Backup Power"; on-device verification
     * (2026-07) confirmed it reads 0 with the backup outlet unused, i.e. it is the EPS port. */
    offgridPower: number;
    /** AC grid port power in W, signed — offset 0x02. On-device verification confirmed this
     * matches the Local API's `ongrid_power` exactly (the reference labels it "Battery Power",
     * but on an AC-coupled unit the AC-port and battery flows are the same measurement). */
    ongridPower: number;
    workMode: number; // raw work-mode byte
    deviceFwVersion: number;
    dailyCharge: number; // kWh
    dailyDischarge: number; // kWh
    totalCharge: number; // kWh
    totalDischarge: number; // kWh
    powerRating?: number; // W (800/2500), only in longer (newer firmware) payloads
    localApiEnabled?: boolean; // Local UDP API state, only in longer payloads
    apiPort?: number; // Local UDP API port, only in longer payloads
}

/**
 * Parses the Runtime Info payload (command 0x03, ~101 bytes).
 * Fields at higher offsets are only present on newer firmware and are set when available.
 * @param {Buffer} p Payload bytes (offset 0 = first byte after CMD).
 * @returns {RuntimeInfo} Decoded runtime values.
 * @throws {Error} When the payload is shorter than expected.
 */
export function parseRuntimeInfo(p: Buffer): RuntimeInfo {
    if (p.length < 0x31) throw new Error(`Runtime payload too short: ${p.length}`);
    const info: RuntimeInfo = {
        offgridPower: p.readInt16LE(0x00),
        ongridPower: p.readInt16LE(0x02),
        workMode: p.readUInt8(0x04),
        deviceFwVersion: p.readUInt16LE(0x0c),
        dailyCharge: p.readUInt32LE(0x0e) / 100,
        dailyDischarge: p.readUInt32LE(0x16) / 100,
        totalCharge: p.readUInt32LE(0x29) / 100,
        totalDischarge: p.readUInt32LE(0x2d) / 100,
    };
    // Output power rating (0x4A, uint16 LE): 800 or 2500 W.
    if (p.length >= 0x4c) info.powerRating = p.readUInt16LE(0x4a);
    // Local API state (0x65, uint8) and port (0x66, uint16 LE).
    if (p.length >= 0x68) {
        info.localApiEnabled = p.readUInt8(0x65) === 1;
        info.apiPort = p.readUInt16LE(0x66);
    }
    return info;
}

/** Decoded fields from the BMS Data response (command 0x14). */
export interface BmsData {
    soc: number; // %
    soh: number; // %
    designCapacity: number; // Wh
    voltage: number; // V
    current: number; // A (signed)
    batteryTemperature: number; // °C
    errorCode: number;
    warningCode: number;
    mosfetTemperature: number; // °C
    cellVoltages: number[]; // V
}

/**
 * Normalises a raw BMS temperature reading. Marstek firmware reports temperature either in
 * whole °C or in deci-°C (0.1 °C units); battery/MOSFET temperatures realistically stay well
 * under 100 °C, so implausibly large values are treated as deci-°C and divided by 10.
 * @param {number} raw Raw uint16 temperature reading.
 * @returns {number} Temperature in °C.
 */
export function normalizeTemperature(raw: number): number {
    return raw > 100 ? raw / 10 : raw;
}

/**
 * Parses the BMS Data payload (command 0x14, ~80 bytes).
 * @param {Buffer} p Payload bytes (offset 0 = first byte after CMD).
 * @returns {BmsData} Decoded battery-management values.
 * @throws {Error} When the payload is shorter than expected.
 */
export function parseBmsData(p: Buffer): BmsData {
    if (p.length < 48) throw new Error(`BMS payload too short: ${p.length}`);

    const cellVoltages: number[] = [];
    for (let i = 48; i + 1 < p.length && i < 82; i += 2) {
        const mv = p.readUInt16LE(i);
        if (mv > 0 && mv < 5000) cellVoltages.push(mv / 1000);
    }

    return {
        soc: p.readUInt16LE(8),
        soh: p.readUInt16LE(10),
        designCapacity: p.readUInt16LE(12),
        voltage: p.readUInt16LE(14) / 100,
        current: p.readInt16LE(16) / 10,
        batteryTemperature: normalizeTemperature(p.readUInt16LE(18)),
        errorCode: p.readUInt16LE(26),
        warningCode: p.readUInt32LE(28),
        mosfetTemperature: normalizeTemperature(p.readUInt16LE(38)),
        cellVoltages,
    };
}

/** Decoded fields from the Device Info response (command 0x04). */
export interface DeviceInfo {
    type: string;
    sn: string;
    mac: string;
    fw: string;
    hw: string;
    [key: string]: string;
}

/**
 * Parses the Device Info payload (command 0x04). The payload is ASCII text of
 * comma-separated `key=value` pairs, e.g. `type=HMG-50,sn=...,mac=...`.
 * @param {Buffer} p Payload bytes.
 * @returns {DeviceInfo} Parsed key/value pairs (unknown keys are preserved).
 */
export function parseDeviceInfo(p: Buffer): DeviceInfo {
    const text = p.toString('ascii').replace(/\0+$/, '');
    const info: DeviceInfo = {
        type: '', sn: '', mac: '', fw: '', hw: '',
    };
    for (const pair of text.split(',')) {
        const idx = pair.indexOf('=');
        if (idx <= 0) continue;
        const key = pair.slice(0, idx).trim().toLowerCase();
        info[key] = pair.slice(idx + 1).trim();
    }
    return info;
}

/**
 * Maps the raw Runtime Info work-mode byte to a `battery_work_mode` capability id.
 * @param {number} mode Raw work-mode byte from Runtime Info offset 0x04.
 * @returns {string} A capability enum id.
 */
export function mapWorkMode(mode: number): string {
    switch (mode) {
        case 0x00: return 'auto';
        case 0x01: return 'standby';
        case 0x02: return 'charging';
        case 0x03: return 'discharging';
        case 0x04: return 'ups';
        case 0x05: return 'force_charge';
        case 0x06: return 'grid_export';
        case 0x07: return 'schedule';
        default: return 'unknown';
    }
}

// ---------------------------------------------------------------------------
// Command payload builders
// ---------------------------------------------------------------------------

/**
 * Builds the payload for the output power-limit command (0x15).
 * @param {number} watts Either 800 or 2500.
 * @returns {number[]} Little-endian 16-bit payload.
 */
export function powerLimitPayload(watts: number): number[] {
    const w = watts >= 2500 ? 2500 : 800;
    return [w & 0xff, (w >> 8) & 0xff];
}

/**
 * Builds the payload for the Local API command (0x28).
 * @param {boolean} enable Whether to enable the Local UDP API.
 * @param {number} [port=30000] UDP port to advertise when enabling.
 * @returns {number[]} `[enableFlag, portLow, portHigh]`.
 */
export function localApiPayload(enable: boolean, port = 30000): number[] {
    return [enable ? 0x01 : 0x00, port & 0xff, (port >> 8) & 0xff];
}

/**
 * Builds the payload for the Depth of Discharge command (0x54).
 * @param {number} percent Depth of discharge, clamped to 30..88.
 * @returns {number[]} Single-byte payload.
 */
export function dodPayload(percent: number): number[] {
    const v = Math.max(30, Math.min(88, Math.round(percent)));
    return [v & 0xff];
}

/**
 * Builds a single-byte on/off payload, used by the Work Mode (0x09) and Backup Power (0x0F)
 * commands.
 * @param {boolean} on Desired state.
 * @returns {number[]} `[0x01]` when on, `[0x00]` when off.
 */
export function onOffPayload(on: boolean): number[] {
    return [on ? 0x01 : 0x00];
}

/**
 * Builds the fixed payload for the system-restart command (0x0C). The battery expects the
 * magic byte sequence used by the reference tool's "System Reset" button.
 * @returns {number[]} The restart command payload.
 */
export function systemResetPayload(): number[] {
    return [0x0a, 0x0b, 0x0c, 0x01];
}
