"use strict";
/**
 * Grid counter accumulator utilities.
 *
 * Purpose:
 * - Convert authoritative cumulative grid counters into bounded-size interval deltas.
 * - Provide reset/out-of-order protection.
 * - Provide deterministic flush behavior (e.g. hourly or at UTC day boundary).
 *
 * Authoritative inputs (from device payload `result`):
 * - `total_grid_input_energy`  (cumulative grid import counter)
 * - `total_grid_output_energy` (cumulative grid export counter)
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.updateGridCounterAccumulator = updateGridCounterAccumulator;
const utcDayKey = (timestampSec) => new Date(timestampSec * 1000).toISOString().split('T')[0];
/**
 * Update an accumulator state with a new grid counter sample.
 *
 * Behavior:
 * - On first sample: initializes baseline.
 * - Out-of-order timestamp: ignored.
 * - Divisor change: resets baseline (prevents unit mixing).
 * - Counter decrease: treated as reset (baseline reset).
 * - Otherwise: accumulates deltas and optionally flushes.
 */
function updateGridCounterAccumulator(previousState, sample, options) {
    const flushIntervalMinutes = options?.flushIntervalMinutes ?? 60;
    const initState = () => ({
        divisorRawPerKwh: sample.divisorRawPerKwh,
        lastTimestampSec: sample.timestampSec,
        lastInputRaw: sample.inputRaw,
        lastOutputRaw: sample.outputRaw,
        accStartTimestampSec: sample.timestampSec,
        accStartInputRaw: sample.inputRaw,
        accStartOutputRaw: sample.outputRaw,
        accInputDeltaRaw: 0,
        accOutputDeltaRaw: 0,
    });
    if (!previousState) {
        return { state: initState(), reason: 'initialized' };
    }
    // Ignore out-of-order samples.
    if (sample.timestampSec <= previousState.lastTimestampSec) {
        return { state: previousState, reason: 'out_of_order' };
    }
    // Divisor change: reset to avoid mixing units.
    if (previousState.divisorRawPerKwh !== sample.divisorRawPerKwh) {
        return { state: initState(), reason: 'divisor_changed' };
    }
    const deltaInputRaw = sample.inputRaw - previousState.lastInputRaw;
    const deltaOutputRaw = sample.outputRaw - previousState.lastOutputRaw;
    // Counter reset detection.
    if (deltaInputRaw < 0 || deltaOutputRaw < 0) {
        return { state: initState(), reason: 'counter_reset' };
    }
    const nextState = {
        ...previousState,
        lastTimestampSec: sample.timestampSec,
        lastInputRaw: sample.inputRaw,
        lastOutputRaw: sample.outputRaw,
        accInputDeltaRaw: previousState.accInputDeltaRaw + deltaInputRaw,
        accOutputDeltaRaw: previousState.accOutputDeltaRaw + deltaOutputRaw,
    };
    const durationMinutes = (sample.timestampSec - nextState.accStartTimestampSec) / 60;
    const crossedUtcDayBoundary = utcDayKey(sample.timestampSec) !== utcDayKey(nextState.accStartTimestampSec);
    const shouldFlush = crossedUtcDayBoundary || durationMinutes >= flushIntervalMinutes;
    if (!shouldFlush) {
        return { state: nextState, reason: 'no_flush' };
    }
    const flush = {
        startTimestampSec: nextState.accStartTimestampSec,
        endTimestampSec: sample.timestampSec,
        durationMinutes,
        startInputRaw: nextState.accStartInputRaw,
        endInputRaw: nextState.accStartInputRaw + nextState.accInputDeltaRaw,
        deltaInputRaw: nextState.accInputDeltaRaw,
        startOutputRaw: nextState.accStartOutputRaw,
        endOutputRaw: nextState.accStartOutputRaw + nextState.accOutputDeltaRaw,
        deltaOutputRaw: nextState.accOutputDeltaRaw,
        divisorRawPerKwh: nextState.divisorRawPerKwh,
    };
    // Reset window for next accumulation.
    nextState.accStartTimestampSec = sample.timestampSec;
    nextState.accStartInputRaw = sample.inputRaw;
    nextState.accStartOutputRaw = sample.outputRaw;
    nextState.accInputDeltaRaw = 0;
    nextState.accOutputDeltaRaw = 0;
    return { state: nextState, flush };
}
