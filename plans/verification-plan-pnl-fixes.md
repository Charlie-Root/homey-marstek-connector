# P&L Fixes Verification Plan

## Overview
This verification plan tests the Profit & Loss (P&L) calculation fixes in the Marstek Venus Homey app. The P&L system calculates financial impact of battery charging (cost) and discharging (savings) based on grid energy counters and electricity prices.

## Key Components Under Test
- **Grid Counter Accumulator**: Tracks cumulative grid import/export energies, handles deltas and resets
- **Financial Calculator**: Safe energy amount and profit/savings calculations with validation
- **Statistics Utils**: Daily aggregation and P&L computation
- **Device Handler**: Processes UDP messages, creates statistics entries, updates capabilities

## Verification Scenarios

### 1. Normal Operation (48h Test)
**Objective**: Verify P&L calculations work correctly over extended periods with realistic energy flows.

**Setup**:
- Enable statistics collection (`enable_statistics: true`)
- Set energy price to 0.2806 €/kWh
- Ensure device receives regular UDP messages with grid counters

**Steps**:
1. **T=0**: Record initial grid counters and capabilities
2. **T=1h**: Verify first hourly flush occurs
   - Expected: Statistics entry logged for any import/export activity
   - Logs: `[P&L_DEBUG] Calculated P&L value for discharging: 0.01 €`
3. **T=24h**: Check daily aggregation
   - Expected: `measure_battery_profit_daily` updated with accumulated P&L
   - Logs: `[AGG_DEBUG] Daily agg for YYYY-MM-DD: ... profitSavings=€X.XX`
4. **T=48h**: Verify 48h accumulation
   - Expected: Total profit reflects 2 days of activity
   - No calculation errors or precision losses

**Expected Behavior**:
- Statistics entries created for import/export activity
- P&L values calculated and stored
- Capabilities updated with profit/savings data
- No application crashes or memory exhaustion

**Success Criteria**:
- P&L values are nonzero when energy deltas exist
- No validation failures or precision loss warnings
- Daily profit accumulates correctly over 48h

### 2. Sanity Check (Minutes Test)
**Objective**: Quick verification of P&L calculation with known inputs.

**Setup**:
- Force a discharge event (0.04 kWh export, 0 kWh import)
- Price: 0.2806 €/kWh

**Steps**:
1. Trigger device message with grid counter increase (output +4 units, divisor=100)
2. Wait for flush (or force via settings)
3. Check logs and capabilities immediately

**Expected Results**:
- Energy delta: 0.04 kWh (discharging)
- P&L calculation: 0.04 kWh × 0.2806 €/kWh = 0.011224 €
- Logs show positive profit/savings value
- `measure_battery_savings_daily` increases by 0.011224 €

### 3. Edge Case: Device Reboot/Reset Counters
**Objective**: Verify system handles counter resets gracefully.

**Setup**:
- Accumulate some grid counter history
- Simulate device reboot (counters reset to 0 or lower values)

**Steps**:
1. Establish baseline with known counter values
2. Send message with decreased counters (reset detected)
3. Verify reset handling and baseline reset

**Expected Behavior**:
- Logs: `[GRID_DEBUG] Counter reset detected: input=X, output=Y`
- New baseline established
- No invalid P&L calculations from negative deltas
- Statistics continue accumulating from reset point

### 4. Edge Case: Counter Wraparound
**Objective**: Handle counter overflow/reset to low values.

**Setup**:
- Set high counter values near maximum
- Send message with wrapped counters (much lower values)

**Steps**:
1. Send message with counters wrapping from high to low
2. Verify wrap detected as reset
3. Check P&L calculations post-wrap

**Expected**:
- Treated as counter reset
- No negative energy deltas calculated
- P&L resumes correctly after wrap

### 5. Edge Case: Missing Readings
**Objective**: Handle gaps in UDP messages gracefully.

**Setup**:
- Stop UDP messages for 2+ hours
- Resume with updated counters

**Steps**:
1. Pause message flow
2. Resume after gap
3. Check large delta handling

**Expected**:
- Large deltas processed correctly
- No outlier rejection for valid large deltas
- P&L calculated for entire gap period

### 6. Edge Case: Negative Deltas (Invalid)
**Objective**: Reject invalid negative deltas from bad data.

**Setup**:
- Send message with counters decreasing without reset

**Steps**:
1. Send invalid message (counters < previous)
2. Verify rejection

**Expected**:
- Logs: `[GRID_DEBUG] Counter reset detected`
- No statistics entry created
- Baseline reset

### 7. Edge Case: Homey App Restart
**Objective**: Verify persistence and recovery after app restart.

**Setup**:
- Accumulate statistics
- Restart Homey app

**Steps**:
1. Record pre-restart state
2. Restart app
3. Check post-restart behavior

**Expected**:
- Grid counter state persists in device store
- Statistics history maintained
- P&L calculations resume correctly
- No duplicate or missing entries

## Validation Checks

### Capability Monitoring
- `measure_battery_profit_daily`: Should update with P&L
- `measure_battery_savings_daily`: Positive for discharging
- `measure_battery_cost_daily`: Positive for charging
- `measure_battery_net_profit_daily`: Net of savings minus costs

### Statistics Verification
- Run `verifyCalculation('last_day', true)` for detailed report
- Check for validation failures, precision losses, outliers
- Verify energy amounts match expected deltas

## Success Criteria Summary
- ✅ P&L nonzero when energy deltas exist
- ✅ No calculation errors in logs
- ✅ Capabilities update correctly
- ✅ Edge cases handled without crashes
- ✅ Statistics persist across restarts
- ✅ Validation passes with no critical issues

## Timeline
- **Minutes**: Sanity checks and basic functionality
- **Hours**: Normal operation and edge cases
- **48h**: Extended verification and accumulation
- **Post-restart**: Persistence validation

## Tools Needed
- Device settings access
- UDP message monitoring
- Statistics export functionality
- Homey app capability inspection