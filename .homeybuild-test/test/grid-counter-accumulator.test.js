"use strict";
/* eslint-disable no-console */
/**
 * Deterministic self-test for grid counter accumulator logic.
 *
 * Run with the npm script: `npm run test:grid-counters`.
 */
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const assert_1 = __importDefault(require("assert"));
const grid_counter_accumulator_1 = require("../lib/grid-counter-accumulator");
const approxEqual = (actual, expected, eps = 1e-9) => {
    assert_1.default.ok(Math.abs(actual - expected) <= eps, `Expected ${actual} ≈ ${expected}`);
};
(() => {
    // Test 1: import-only interval, flush at 60 minutes.
    let state = null;
    state = (0, grid_counter_accumulator_1.updateGridCounterAccumulator)(state, {
        timestampSec: 0,
        inputRaw: 1000,
        outputRaw: 500,
        divisorRawPerKwh: 10,
    }).state;
    const r1 = (0, grid_counter_accumulator_1.updateGridCounterAccumulator)(state, {
        timestampSec: 3600,
        inputRaw: 1010,
        outputRaw: 500,
        divisorRawPerKwh: 10,
    }, { flushIntervalMinutes: 60 });
    assert_1.default.ok(r1.flush);
    assert_1.default.equal(r1.flush.deltaInputRaw, 10);
    assert_1.default.equal(r1.flush.deltaOutputRaw, 0);
    approxEqual(r1.flush.durationMinutes, 60);
    // Test 2: export-only interval.
    state = null;
    state = (0, grid_counter_accumulator_1.updateGridCounterAccumulator)(state, {
        timestampSec: 0,
        inputRaw: 2000,
        outputRaw: 300,
        divisorRawPerKwh: 10,
    }).state;
    const r2 = (0, grid_counter_accumulator_1.updateGridCounterAccumulator)(state, {
        timestampSec: 3600,
        inputRaw: 2000,
        outputRaw: 320,
        divisorRawPerKwh: 10,
    }, { flushIntervalMinutes: 60 });
    assert_1.default.ok(r2.flush);
    assert_1.default.equal(r2.flush.deltaInputRaw, 0);
    assert_1.default.equal(r2.flush.deltaOutputRaw, 20);
    // Test 3: missing intermediate sample; still correct delta at flush.
    state = null;
    state = (0, grid_counter_accumulator_1.updateGridCounterAccumulator)(state, {
        timestampSec: 0,
        inputRaw: 1000,
        outputRaw: 100,
        divisorRawPerKwh: 10,
    }).state;
    const r3 = (0, grid_counter_accumulator_1.updateGridCounterAccumulator)(state, {
        timestampSec: 7200,
        inputRaw: 1030,
        outputRaw: 110,
        divisorRawPerKwh: 10,
    }, { flushIntervalMinutes: 60 });
    assert_1.default.ok(r3.flush);
    assert_1.default.equal(r3.flush.deltaInputRaw, 30);
    assert_1.default.equal(r3.flush.deltaOutputRaw, 10);
    // Test 4: counter reset (decrease) resets baseline and does not flush.
    state = null;
    state = (0, grid_counter_accumulator_1.updateGridCounterAccumulator)(state, {
        timestampSec: 0,
        inputRaw: 5000,
        outputRaw: 1200,
        divisorRawPerKwh: 10,
    }).state;
    // Increase normally (no flush yet).
    state = (0, grid_counter_accumulator_1.updateGridCounterAccumulator)(state, {
        timestampSec: 1800,
        inputRaw: 5020,
        outputRaw: 1210,
        divisorRawPerKwh: 10,
    }, { flushIntervalMinutes: 60 }).state;
    // Reset detected.
    const r4 = (0, grid_counter_accumulator_1.updateGridCounterAccumulator)(state, {
        timestampSec: 2400,
        inputRaw: 5,
        outputRaw: 2,
        divisorRawPerKwh: 10,
    }, { flushIntervalMinutes: 60 });
    assert_1.default.equal(r4.reason, 'counter_reset');
    assert_1.default.ok(!r4.flush);
    console.log('grid-counter-accumulator tests: OK');
})();
