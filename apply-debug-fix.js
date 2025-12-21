/**
 * Quick fix script to add enhanced debugging to device.ts
 * This script adds comprehensive logging to identify P&L calculation issues
 */

const fs = require('fs');
const path = require('path');

const deviceTsPath = path.join(__dirname, 'drivers/marstek-venus/device.ts');

function applyDebugFix() {
  console.log('Applying enhanced debugging to device.ts...');
  
  // Read the current file
  let content = fs.readFileSync(deviceTsPath, 'utf8');
  
  // Add debug logging for grid counter values
  const gridCounterDebug = `
      // DEBUG: Log current grid counter values for troubleshooting
      if (this.debug) {
        this.log(\`[P&L] Current grid counters: input=\${result.total_grid_input_energy}, output=\${result.total_grid_output_energy}, divisor=\${divisorRawPerKwh}\`);
      }

      // DEBUG: Check if counters are static (no energy flow)
      const storedState: GridCounterAccumulatorState | null = this.getStoreValue(MarstekVenusDevice.GRID_COUNTER_ACCUMULATOR_STORE_KEY) || null;
      if (storedState && this.debug) {
        const currentInputRaw = Number(result.total_grid_input_energy);
        const currentOutputRaw = Number(result.total_grid_output_energy);
        const deltaInput = currentInputRaw - storedState.lastInputRaw;
        const deltaOutput = currentOutputRaw - storedState.lastOutputRaw;
        if (deltaInput === 0 && deltaOutput === 0) {
          this.log(\`[P&L] WARNING: Grid counters are static - no energy flow detected. Input: \${currentInputRaw}, Output: \${currentOutputRaw}\`);
        } else {
          this.log(\`[P&L] Energy flow detected: input_delta=\${deltaInput}, output_delta=\${deltaOutput}\`);
        }
      }`;

  // Add debug logging for accumulator update
  const accumulatorDebug = `
        // DEBUG: Log accumulator update result
        if (this.debug) {
          this.log(\`[P&L] Accumulator update: reason=\${update.reason}, hasFlush=\${!!update.flush}, accInputDelta=\${update.state.accInputDeltaRaw}, accOutputDelta=\${update.state.accOutputDeltaRaw}\`);
        }`;

  // Add debug logging for P&L calculations
  const plCalculationDebug = `
            // DEBUG: Always log P&L calculation results when debug is enabled
            if (this.debug) {
              const profitSavingsResult = calculateProfitSavings(entry);
              this.log(\`[P&L] Calculated P&L value for \${entry.type}: €\${profitSavingsResult.profitSavings.toFixed(2)} (energy: \${Math.abs(entry.energyAmount).toFixed(3)} kWh, price: €\${entry.priceAtTime?.toFixed(4)}/kWh)\`);
            }`;

  // Add debug logging for final accumulator state
  const finalStateDebug = `
        // DEBUG: Log final accumulator state
        if (this.debug) {
          const finalState = update.state;
          this.log(\`[P&L] Final accumulator state: duration=\${(nowSec - finalState.accStartTimestampSec) / 60}min, accInputDelta=\${finalState.accInputDeltaRaw}, accOutputDelta=\${finalState.accOutputDeltaRaw}\`);
        }`;

  // Apply the fixes
  // 1. Add grid counter debug after the initial log
  const initialLogPattern = `if (this.debug) this.log('enable_statistics is enabled, processing grid counter statistics');`;
  content = content.replace(initialLogPattern, initialLogPattern + gridCounterDebug);

  // 2. Add accumulator debug after the updateGridCounterAccumulator call
  const accumulatorUpdatePattern = `}, {
          flushIntervalMinutes: 60,
        });`;
  content = content.replace(accumulatorUpdatePattern, accumulatorUpdatePattern + accumulatorDebug);

  // 3. Add P&L calculation debug in both charging and discharging sections
  const chargingPattern = `if (this.debug) {
               const profitSavingsResult = calculateProfitSavings(entry);
               this.log('[P&L] Calculated P&L value for charging:', profitSavingsResult.profitSavings, '€');
             }`;
  content = content.replace(chargingPattern, plCalculationDebug);

  const dischargingPattern = `if (this.debug) {
               const profitSavingsResult = calculateProfitSavings(entry);
               this.log('[P&L] Calculated P&L value for discharging:', profitSavingsResult.profitSavings, '€');
             }`;
  content = content.replace(dischargingPattern, plCalculationDebug);

  // 4. Add final state debug before setStoreValue
  const storeValuePattern = `await this.setStoreValue(MarstekVenusDevice.GRID_COUNTER_ACCUMULATOR_STORE_KEY, update.state);`;
  content = content.replace(storeValuePattern, finalStateDebug + '\n\n        ' + storeValuePattern);

  // Write the modified content back
  fs.writeFileSync(deviceTsPath, content);
  
  console.log('✅ Enhanced debugging has been added to device.ts');
  console.log('');
  console.log('Next steps:');
  console.log('1. Enable debug mode in your device settings');
  console.log('2. Restart the Homey app');
  console.log('3. Monitor logs for [P&L] messages');
  console.log('4. Look for "WARNING: Grid counters are static" messages');
  console.log('5. Check for "Energy flow detected" messages');
  console.log('6. Verify P&L calculation logs appear');
}

// Run the fix
try {
  applyDebugFix();
} catch (error) {
  console.error('Error applying debug fix:', error.message);
  process.exit(1);
}