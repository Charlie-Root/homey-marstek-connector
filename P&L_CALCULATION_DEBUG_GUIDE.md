# P&L Calculation Debug Guide

## Problem Summary

Profit/loss calculations are not being performed despite statistics being enabled. The logs show "enable_statistics is enabled, processing grid counter statistics" but no actual P&L calculations are logged. The grid counters (total_grid_input_energy: 80184, total_grid_output_energy: 61375) appear to be static, suggesting no energy flow changes are being detected.

## Root Cause Analysis

Based on the code analysis and debugging simulation, the following issues have been identified:

### 1. **Static Counters Issue (Primary Cause)**
- The grid counters are not changing between polling cycles
- No energy flow means no deltas to accumulate
- Without deltas, no flush occurs, so no calculations are triggered
- **Evidence**: Counters remain at 80184 (input) and 61375 (output) consistently

### 2. **Flush Interval Timing**
- Default flush interval is 60 minutes
- Even with small energy changes, calculations only trigger after 60 minutes
- This creates a long delay between energy flow and P&L calculation

### 3. **Debug Logging Issues**
- P&L calculation logs only appear when `debug` mode is enabled
- The logs `[P&L] Calculated P&L value for charging/discharing: €X.XX` are conditional on debug mode
- If debug is disabled, no calculation logs appear even when calculations occur

### 4. **Price Validation**
- Invalid or missing energy prices prevent calculations
- Price validation must pass for P&L calculations to proceed

## Debugging Steps

### Step 1: Verify Energy Flow
Check if the grid counters are actually changing:

```javascript
// Add this to your device.ts for debugging
if (this.debug) {
  const currentInput = result.total_grid_input_energy;
  const currentOutput = result.total_grid_output_energy;
  const storedState = this.getStoreValue('grid_counter_accumulator');
  
  if (storedState) {
    const deltaInput = currentInput - storedState.lastInputRaw;
    const deltaOutput = currentOutput - storedState.lastOutputRaw;
    this.log(`[DEBUG] Grid counter deltas: input=${deltaInput}, output=${deltaOutput}`);
  }
}
```

### Step 2: Check Accumulator State
Monitor the accumulator state to see if deltas are being tracked:

```javascript
// Add this after the accumulator update
if (this.debug) {
  const state = update.state;
  this.log(`[DEBUG] Accumulator state: accInputDeltaRaw=${state.accInputDeltaRaw}, accOutputDeltaRaw=${state.accOutputDeltaRaw}, durationMinutes=${(nowSec - state.accStartTimestampSec) / 60}`);
}
```

### Step 3: Force Debug Mode
Ensure debug mode is enabled in device settings to see calculation logs:

1. Go to device settings in Homey
2. Enable "Debug logging"
3. Check logs for `[P&L] Calculated P&L value` messages

### Step 4: Verify Price Settings
Check that energy price is properly configured:

```javascript
// Add this to verify price
const price = this.getCurrentEnergyPrice();
if (this.debug) {
  this.log(`[DEBUG] Current energy price: €${price}/kWh`);
}
```

## Potential Fixes

### Fix 1: Reduce Flush Interval
Modify the flush interval to trigger calculations more frequently:

```javascript
// In processGridCounterStatistics, change:
const update = updateGridCounterAccumulator(storedState, {
  timestampSec: nowSec,
  inputRaw: currentInputRaw,
  outputRaw: currentOutputRaw,
  divisorRawPerKwh,
}, {
  flushIntervalMinutes: 15, // Changed from 60 to 15 minutes
});
```

### Fix 2: Add Minimum Delta Trigger
Add a minimum energy delta that triggers calculations regardless of time:

```javascript
// Add this check before the accumulator update
const minDeltaTrigger = 0.1; // 0.1 kWh minimum
const currentInputRaw = Number(result.total_grid_input_energy);
const currentOutputRaw = Number(result.total_grid_output_energy);

if (storedState) {
  const deltaInputKwh = (currentInputRaw - storedState.lastInputRaw) / divisorRawPerKwh;
  const deltaOutputKwh = (currentOutputRaw - storedState.lastOutputRaw) / divisorRawPerKwh;
  
  if (Math.abs(deltaInputKwh) >= minDeltaTrigger || Math.abs(deltaOutputKwh) >= minDeltaTrigger) {
    // Force flush even if time interval hasn't passed
    // This would require modifying the accumulator logic
  }
}
```

### Fix 3: Enhanced Debug Logging
Add more comprehensive logging to track the calculation flow:

```javascript
// Add this in processGridCounterStatistics
if (this.debug) {
  this.log(`[P&L] Processing grid counters: input=${currentInputRaw}, output=${currentOutputRaw}, divisor=${divisorRawPerKwh}`);
  this.log(`[P&L] Accumulator state: ${JSON.stringify(storedState)}`);
  this.log(`[P&L] Update result: reason=${update.reason}, hasFlush=${!!update.flush}`);
}
```

### Fix 4: Verify Device Configuration
Ensure the device is properly configured for statistics:

1. **Enable Statistics**: Check that `enable_statistics` is enabled in device settings
2. **Set Energy Price**: Ensure `price_per_kwh` is set to a valid value (e.g., 0.30)
3. **Enable Debug**: Turn on debug logging to see calculation messages
4. **Check Firmware**: Verify firmware version supports grid counter reporting

## Testing the Fixes

### Test 1: Simulate Energy Flow
Create a test script to simulate energy flow changes:

```javascript
// Test script to simulate energy flow
const testStates = [
  { input: 80184, output: 61375 }, // Initial
  { input: 80185, output: 61376 }, // +1 unit each
  { input: 80186, output: 61377 }, // +1 unit each
  // ... more increments
];

for (const state of testStates) {
  // Simulate device message processing
  await device.onMessage({
    src: device.getSetting('src'),
    result: {
      total_grid_input_energy: state.input,
      total_grid_output_energy: state.output,
      // ... other fields
    }
  }, { address: 'test' });
}
```

### Test 2: Monitor Logs
After applying fixes, monitor logs for:

1. `[P&L] Processing grid counters` messages
2. `[P&L] Calculated P&L value` messages
3. `Logged statistics entry` messages
4. `Updated profit capabilities` messages

### Test 3: Verify Capabilities
Check that the following capabilities are being updated:

- `measure_battery_profit_daily`
- `measure_battery_profit_hourly`
- `measure_battery_charge_energy_daily`
- `measure_battery_discharge_energy_daily`
- `measure_battery_savings_daily`
- `measure_battery_cost_daily`
- `measure_battery_net_profit_daily`

## Expected Behavior After Fixes

1. **Energy Flow Detection**: Grid counters should show changes over time
2. **Calculation Triggers**: P&L calculations should occur when energy flows are detected
3. **Log Messages**: Debug logs should show calculation progress
4. **Capability Updates**: Profit and energy capabilities should be updated with calculated values
5. **Flow Triggers**: Statistics flow cards should be triggered when calculations occur

## Troubleshooting Checklist

- [ ] Debug logging is enabled
- [ ] Statistics are enabled in device settings
- [ ] Energy price is configured and valid
- [ ] Grid counters are actually changing (not static)
- [ ] Device firmware supports grid counter reporting
- [ ] No error messages in logs about validation failures
- [ ] Accumulator state is being stored and retrieved correctly
- [ ] Flush conditions are being met (time or delta thresholds)

## Next Steps

1. Apply the debugging enhancements to see what's happening
2. Check if grid counters are actually changing
3. Adjust flush interval if needed
4. Verify energy price configuration
5. Test with simulated energy flow if real flow isn't available