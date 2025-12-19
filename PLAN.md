# Plan for Integrating Electricity Rate-Based Cost Tracking in Marstek Venus Homey App

## Overview
This plan outlines the implementation of daily cost tracking for battery charging and savings from discharging, based on real-time electricity rates retrieved from the PowerByTheHour app (app ID: com.gruijter.powerhour). The focus is on the local Marstek Venus driver, as specified by the user.

## Current App Functionality
The Marstek Venus app retrieves battery statistics via local UDP API, including:
- State of charge (measure_battery)
- Real-time power (measure_power)
- Cumulative energy imported (charged) in kWh (meter_power.imported)
- Cumulative energy exported (discharged) in kWh (meter_power.exported)
- Other metrics like temperature, RSSI, etc.

Data is polled periodically (configurable interval) and capabilities are updated on each received message.

## Requirements
- Calculate daily cost of energy charged into the battery
- Calculate daily savings from energy discharged from the battery
- Use current electricity rates from PowerByTheHour app
- Reset calculations daily (at midnight)
- Display costs in EUR (or user's currency)
- Provide historical daily cost/savings data for trend analysis

## Technical Approach

### 1. New Capabilities
Add two new capabilities to `drivers/marstek-venus/driver.compose.json`:
- `daily_charge_cost`: Measure capability for accumulated cost of charged energy (EUR)
- `daily_discharge_savings`: Measure capability for accumulated savings from discharged energy (EUR)

Include in capabilities array and add to capabilityOptions for proper titles and units.

### 2. Data Storage
Use device store values to persist:
- `prev_imported`: Previous cumulative imported energy (kWh)
- `prev_exported`: Previous cumulative exported energy (kWh)
- `daily_charge_cost`: Running total for current day (EUR)
- `daily_discharge_savings`: Running total for current day (EUR)
- `last_reset_date`: Date string (YYYY-MM-DD) of last daily reset
- `daily_history`: Array of objects with {date: 'YYYY-MM-DD', charge_cost: number, discharge_savings: number, imported_kwh: number, exported_kwh: number}
  - Limit to last 30 days to prevent storage bloat
  - Store daily totals when resetting

### 3. Rate Retrieval
In device code, query PowerByTheHour devices:
```typescript
const devices = await this.homey.api.devices.getDevices();
const powerHourDevices = devices.filter(d => d.driverUri === 'com.gruijter.powerhour');
if (powerHourDevices.length > 0) {
    const rate = await powerHourDevices[0].getCapabilityValue('measure_price'); // Assume EUR/kWh
    // Use rate for calculations
}
```
Assumption: PowerByTheHour provides 'measure_price' capability with current rate in EUR/kWh.

### 4. Cost Calculation Logic
In `onMessage()` method, after updating meter_power.imported/exported:

1. Check for daily reset (if current date > last_reset_date):
   - Store previous day's totals in daily_history array
   - Reset daily_charge_cost and daily_discharge_savings to 0
   - Update last_reset_date
   - Store current imported/exported as prev_imported/exported
   - Clean up history array (keep last 30 days)

2. Calculate deltas:
   - delta_imported = current_imported - prev_imported
   - delta_exported = current_exported - prev_exported

3. Retrieve current electricity rate from PowerByTheHour device

4. If delta > 0 and rate available:
   - daily_charge_cost += delta_imported * rate  (reflects time-of-use pricing for charging)
   - daily_discharge_savings += delta_exported * rate  (reflects time-of-use pricing for discharging)

5. Update prev_imported/exported to current values

6. Set capability values for daily_charge_cost and daily_discharge_savings

Note: Since rates change hourly, the accumulated costs reflect the actual rates at the time of charging/discharging. For example, charging at night (0.16 EUR/kWh) and discharging during day (0.27 EUR/kWh) will show lower daily costs and higher daily savings, demonstrating the arbitrage benefit.

### 5. Edge Cases Handling
- Handle device restart: Load stored values on init
- Rate unavailable: Skip cost updates, log warning
- Negative deltas (unlikely, but possible due to resets): Ignore or log
- Firmware differences: Ensure energy values are correctly scaled (as currently done)

### 6. User Configuration
Add settings for:
- Currency symbol/unit (default EUR)
- Whether to enable cost tracking (default enabled)
- Option to select specific PowerByTheHour device if multiple
- History retention period (default 30 days)

### 7. Implementation Steps
1. Update driver.compose.json with new capabilities
2. Modify device.ts to add cost calculation logic
3. Add store value management in onInit/resetCapabilities
4. Test with mock rates initially
5. Integrate with actual PowerByTheHour API calls
6. Add error handling and logging

### 8. Potential Challenges
- Ensuring accurate delta calculations across device restarts
- Handling multiple PowerByTheHour devices (select primary or average)
- Time zone considerations for daily resets
- Performance impact of API calls on each poll (consider caching rate for short periods)

### 9. Future Enhancements
- Hourly cost breakdown
- Historical data storage
- Integration with Homey's energy dashboard
- Alerts for high-cost charging periods

## Dependencies
- PowerByTheHour app must be installed and configured
- At least one PowerByTheHour device providing current price data

## Testing
- Unit tests for cost calculation logic
- Integration tests with mock PowerByTheHour data
- Manual testing with real battery and rate data
- Verify daily resets and persistence across app restarts