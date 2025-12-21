# Marstek API to Homey Device Capabilities - Comprehensive Mapping

## Executive Summary

This document provides a detailed mapping between the Marstek Device Open API specifications and the Homey device capabilities implemented in the Marstek Battery Connector application. It includes code analysis, data transformations, identified gaps, and enhancement opportunities.

## Table of Contents

1. [API Call to Capability Mappings](#api-call-to-capability-mappings)
2. [Data Transformations and Calculations](#data-transformations-and-calculations)
3. [Implementation Gaps and Enhancement Opportunities](#implementation-gaps-and-enhancement-opportunities)
4. [Bug Fixes and Improvements](#bug-fixes-and-improvements)
5. [Code Analysis and Architecture](#code-analysis-and-architecture)
6. [Recommendations](#recommendations)

## API Call to Capability Mappings

### 1. ES.GetStatus → Core Energy Capabilities

**API Call**: `ES.GetStatus` (lines 112-114 in device.ts)
```json
{
  "method": "ES.GetStatus",
  "params": {"id": 0}
}
```

**Response Fields Mapped to Capabilities**:

| API Field | Homey Capability | Code Location | Data Transformation |
|-----------|------------------|---------------|-------------------|
| `bat_soc` | `measure_battery` | device.ts:241 | Direct assignment |
| `bat_power` | `measure_power` | device.ts:248 | Scaled by firmware divisor |
| `total_grid_input_energy` | `meter_power.imported` | device.ts:257 | Divided by firmware divisor |
| `total_grid_output_energy` | `meter_power.exported` | device.ts:263 | Divided by firmware divisor |
| `total_load_energy` | `meter_power.load` | device.ts:266 | Divided by firmware divisor |
| `ongrid_power` | `measure_power_ongrid` | device.ts:269 | Multiplied by -1 |
| `offgrid_power` | `measure_power_offgrid` | device.ts:270 | Multiplied by -1 |
| `pv_power` | `measure_power_pv` | device.ts:271 | Multiplied by -1 |

**Code Implementation**:
```typescript
// device.ts:238-266
if (!isNaN(result.bat_capacity)) {
  await this.setCapabilityValue('meter_power', result.bat_capacity / ((firmware >= 154) ? 1000.0 : 100.0));
}
if (!isNaN(result.bat_power)) {
  await this.setCapabilityValue('measure_power', result.bat_power / ((firmware >= 154) ? 1.0 : 10.0));
}
```

### 2. ES.GetMode → Battery Mode Capabilities

**API Call**: `ES.GetMode` (lines 114-115 in device.ts)
```json
{
  "method": "ES.GetMode",
  "params": {"id": 0}
}
```

**Response Fields Mapped to Capabilities**:

| API Field | Homey Capability | Code Location | Data Transformation |
|-----------|------------------|---------------|-------------------|
| `mode` | `battery_mode` | device.ts:289 | Filtered to valid modes |
| `ongrid_power` | `measure_power_ongrid` | device.ts:269 | Multiplied by -1 |
| `offgrid_power` | `measure_power_offgrid` | device.ts:270 | Multiplied by -1 |
| `bat_soc` | `measure_battery` | device.ts:241 | Direct assignment |

**Code Implementation**:
```typescript
// device.ts:285-291
if (result.mode) {
  const mode = result.mode.toLowerCase();
  if (['ai', 'auto', 'force_charge', 'force_discharge'].includes(mode)) {
    await this.setCapabilityValue('battery_mode', mode);
  }
}
```

### 3. EM.GetStatus → Three-Phase Power Capabilities

**API Call**: `EM.GetStatus` (lines 115-116 in device.ts)
```json
{
  "method": "EM.GetStatus",
  "params": {"id": 0}
}
```

**Response Fields Mapped to Capabilities**:

| API Field | Homey Capability | Code Location | Data Transformation |
|-----------|------------------|---------------|-------------------|
| `ct_state` | `measure_ct_state` | device.ts:298 | Converted to string |
| `a_power` | `measure_power.a` | device.ts:303 | Direct assignment |
| `b_power` | `measure_power.b` | device.ts:304 | Direct assignment |
| `c_power` | `measure_power.c` | device.ts:305 | Direct assignment |
| `total_power` | `measure_power.total` | device.ts:306 | Direct assignment |

**Code Implementation**:
```typescript
// device.ts:294-306
if (result.ct_state !== undefined) {
  const currentCtState = await this.getCapabilityValue('measure_ct_state');
  const newCtState = result.ct_state.toString();
  if (currentCtState !== newCtState) {
    await this.setCapabilityValue('measure_ct_state', newCtState);
    await this.homey.flow.getTriggerCard('marstek_ct_state_changed').trigger({ state: result.ct_state });
  }
}
```

### 4. Wifi.GetStatus → Network Capabilities

**API Call**: `Wifi.GetStatus` (lines 113-114 in device.ts)
```json
{
  "method": "Wifi.GetStatus",
  "params": {"id": 0}
}
```

**Response Fields Mapped to Settings**:

| API Field | Homey Setting | Code Location | Data Transformation |
|-----------|---------------|---------------|-------------------|
| `ssid` | `wifi_ssid` | device.ts:278 | Direct assignment |
| `rssi` | `measure_rssi` | device.ts:276 | Direct assignment |
| `sta_ip` | `wifi_ip` | device.ts:279 | Direct assignment |
| `sta_gate` | `wifi_gateway` | device.ts:280 | Direct assignment |
| `sta_mask` | `wifi_subnet` | device.ts:281 | Direct assignment |
| `sta_dns` | `wifi_dns` | device.ts:282 | Direct assignment |

**Code Implementation**:
```typescript
// device.ts:274-282
if (!isNaN(result.rssi)) {
  await this.setCapabilityValue('measure_rssi', result.rssi);
}
if (result.ssid) await this.setSettings({ wifi_ssid: result.ssid });
if (result.sta_ip) await this.setSettings({ wifi_ip: result.sta_ip });
```

### 5. Bat.GetStatus → Battery Health Capabilities

**API Call**: `Bat.GetStatus` (lines 112-113 in device.ts)
```json
{
  "method": "Bat.GetStatus",
  "params": {"id": 0}
}
```

**Response Fields Mapped to Capabilities**:

| API Field | Homey Capability | Code Location | Data Transformation |
|-----------|------------------|---------------|-------------------|
| `bat_temp` | `measure_temperature` | device.ts:334 | Scaled if >50 |
| `bat_capacity` | `meter_power` | device.ts:238 | Divided by firmware divisor |
| `soc` | `measure_battery` | device.ts:241 | Direct assignment |

**Code Implementation**:
```typescript
// device.ts:331-335
if (!isNaN(result.bat_temp)) {
  if (result.bat_temp > 50) result.bat_temp /= 10.0;
  await this.setCapabilityValue('measure_temperature', result.bat_temp);
}
```

## Data Transformations and Calculations

### 1. Firmware-Based Scaling

**Purpose**: Handle different firmware versions with varying data scales

**Implementation**:
```typescript
// device.ts:238, 252, 266
const divisor = (firmware >= 154) ? 10.0 : 100.0;
const divisorPower = (firmware >= 154) ? 1.0 : 10.0;

// Energy values
await this.setCapabilityValue('meter_power', result.bat_capacity / ((firmware >= 154) ? 1000.0 : 100.0));
await this.setCapabilityValue('meter_power.imported', result.total_grid_input_energy / divisor);
await this.setCapabilityValue('meter_power.exported', result.total_grid_output_energy / divisor);

// Power values
await this.setCapabilityValue('measure_power', result.bat_power / divisorPower);
```

**Firmware Version Detection**:
```typescript
// device.ts:209-220
let firmware = 0;
if (this.getSetting('firmware')) {
  firmware = Number(String(this.getSetting('firmware')).replace(/\./g, ''));
} else {
  const model = this.getSetting('model');
  if (model) {
    const versionPart = model.split(' v')[1];
    if (versionPart) {
      firmware = Number(versionPart.replace(/\./g, ''));
    }
  }
}
```

### 2. Power Direction Conversion

**Purpose**: Convert Marstek's power direction convention to Homey's convention

**Implementation**:
```typescript
// device.ts:269-271
if (!isNaN(result.ongrid_power)) await this.setCapabilityValue('measure_power_ongrid', result.ongrid_power * -1);
if (!isNaN(result.offgrid_power)) await this.setCapabilityValue('measure_power_offgrid', result.offgrid_power * -1);
if (!isNaN(result.pv_power)) await this.setCapabilityValue('measure_power_pv', result.pv_power * -1);
```

**Convention Mapping**:
- Marstek: Positive = Generation, Negative = Consumption
- Homey: Positive = Consumption, Negative = Generation

### 3. Battery Charging State Calculation

**Purpose**: Derive charging state from battery power value

**Implementation**:
```typescript
// device.ts:245-249
if (!isNaN(result.bat_power)) {
  await this.setCapabilityValue('battery_charging_state', 
    (result.bat_power > 0) ? 'charging' : (result.bat_power < 0) ? 'discharging' : 'idle'
  );
  await this.setCapabilityValue('measure_power', result.bat_power / divisorPower);
}
```

**State Mapping**:
- `bat_power > 0` → "charging"
- `bat_power < 0` → "discharging" 
- `bat_power = 0` → "idle"

### 4. Statistics and Profit Calculations

**Purpose**: Calculate financial metrics from energy data

**Implementation**:
```typescript
// lib/statistics-utils.ts:122-216
export function calculateEnergyAmount(
  type: 'charging' | 'discharging',
  startMeter?: number,
  endMeter?: number,
  divisor?: number,
  power?: number,
  timeIntervalHours?: number,
  historicalValues: number[] = [],
): { energyAmount: number; audit: any; warnings: string[] } {
  // Comprehensive safety checks and calculations
  // Uses FinancialCalculator for precision control
}
```

**Key Features**:
- Banker's rounding for financial precision
- Zero division protection
- Outlier detection
- Precision loss monitoring
- Comprehensive audit trail

### 5. Grid Counter Accumulation

**Purpose**: Convert cumulative grid counters to interval-based statistics

**Implementation**:
```typescript
// lib/grid-counter-accumulator.ts:75-156
export function updateGridCounterAccumulator(
  previousState: GridCounterAccumulatorState | null,
  sample: GridCounterSample,
  options?: { flushIntervalMinutes?: number },
): GridCounterUpdate {
  // Handles counter resets, out-of-order samples, and deterministic flushing
}
```

**Features**:
- Reset/out-of-order protection
- Deterministic flush behavior (hourly/UTC day boundary)
- Authoritative cumulative counter handling

## Implementation Gaps and Enhancement Opportunities

### 1. Missing API Calls

#### PV.GetStatus (Venus D Model)
**Status**: Not implemented
**API**: `PV.GetStatus` for photovoltaic charging information
**Missing Capabilities**:
- `pv_power` (W)
- `pv_voltage` (V) 
- `pv_current` (A)

**Enhancement Opportunity**:
```typescript
// Proposed implementation
if (result.pv_power !== undefined) {
  await this.setCapabilityValue('measure_power_pv', result.pv_power);
  await this.setCapabilityValue('measure_voltage_pv', result.pv_voltage);
  await this.setCapabilityValue('measure_current_pv', result.pv_current);
}
```

#### BLE.GetStatus
**Status**: Not implemented
**API**: `BLE.GetStatus` for Bluetooth connection status
**Missing Capabilities**:
- Bluetooth connectivity monitoring
- Mobile app pairing status

#### Marstek.GetDevice
**Status**: Partially implemented (discovery only)
**API**: `Marstek.GetDevice` for device discovery
**Enhancement Opportunity**: Device model detection for feature availability

### 2. Missing Capabilities

#### Battery Health Monitoring
**Missing Capabilities**:
- `measure_battery_health` (from `rated_capacity` vs `bat_capacity`)
- `measure_battery_cycles` (not available in API)
- `measure_battery_voltage` (not available in API)

#### Advanced Power Quality
**Missing Capabilities**:
- `measure_voltage` (grid voltage)
- `measure_frequency` (grid frequency)
- `measure_power_factor` (power factor)

#### Device Diagnostics
**Missing Capabilities**:
- `alarm_battery` (low battery warnings)
- `alarm_grid` (grid connection issues)
- `alarm_temperature` (overheating warnings)

### 3. Enhanced Statistics

#### Missing Statistical Capabilities
- `measure_battery_efficiency` (charge/discharge efficiency)
- `measure_self_discharge` (battery self-discharge rate)
- `measure_grid_usage_hours` (grid connection hours)

#### Missing Financial Capabilities
- `measure_battery_roi` (return on investment)
- `measure_carbon_offset` (carbon emission reduction)
- `measure_peak_shaving` (peak demand reduction)

### 4. Advanced Control Features

#### Missing Control Capabilities
- `target_soc` (target state of charge)
- `charge_limit` (maximum charge power)
- `discharge_limit` (maximum discharge power)
- `time_of_use` (time-based pricing optimization)

## Bug Fixes and Improvements

### 1. Critical Fixes Implemented

#### Financial Calculator Precision Issues
**Problem**: Floating-point precision errors in financial calculations
**Solution**: Implemented banker's rounding and precision loss detection
```typescript
// lib/financial-calculator.ts:302-326
export function bankersRounding(value: number, decimals: number = 2): number {
  // Banker's rounding implementation with overflow protection
}
```

#### Memory Management Issues
**Problem**: Memory leaks in statistics accumulation
**Solution**: Implemented ring buffer approach and memory monitoring
```typescript
// lib/financial-calculator.ts:552-562
if (this.auditTrail.length >= this.MAX_AUDIT_TRAIL_SIZE) {
  this.auditTrail = this.auditTrail.slice(-this.MAX_AUDIT_TRAIL_SIZE + 50);
}
```

#### Zero Division Protection
**Problem**: Division by zero errors in calculations
**Solution**: Comprehensive safe division with fallback values
```typescript
// lib/financial-calculator.ts:336-365
export function safeDivide(
  numerator: number,
  denominator: number,
  defaultValue: number = 0,
  decimals: number = FINANCIAL_CONSTANTS.CURRENCY_DECIMALS,
): number {
  // Zero division protection with precision control
}
```

### 2. Data Validation Improvements

#### Input Validation
**Enhancement**: Comprehensive input validation for all calculations
```typescript
// lib/financial-calculator.ts:372-404
export function validateEnergyAmount(energyAmount: number): ValidationResult {
  // Validates energy amount with bounds checking
}
```

#### Outlier Detection
**Enhancement**: Statistical outlier detection for abnormal readings
```typescript
// lib/financial-calculator.ts:816-843
export function detectOutlier(
  currentValue: number,
  historicalValues: number[],
  threshold: number = 2.5,
): { isOutlier: boolean; zScore: number; mean: number; stdDev: number } {
  // Z-score based outlier detection
}
```

### 3. Error Handling Improvements

#### Graceful Degradation
**Enhancement**: System continues operation despite individual calculation failures
```typescript
// lib/statistics-utils.ts:191-215
try {
  // Calculation logic
} catch (error) {
  warnings.push(`Calculation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
  return { energyAmount: 0, audit, warnings };
}
```

#### Audit Trail
**Enhancement**: Comprehensive logging of all calculations for debugging
```typescript
// lib/statistics-utils.ts:178-183
const audit = {
  ...result.audit,
  recoveryActions,
  finalEnergyAmount: energyAmount,
  warnings: [...warnings, ...(result.audit.validation.warnings || [])],
};
```

### 4. Performance Optimizations

#### Memory Optimization
**Enhancement**: Lazy report generation and memory monitoring
```typescript
// lib/financial-calculator.ts:546-575
private performMemoryCleanup(forceCleanup: boolean = false): boolean {
  // Ring buffer approach to prevent unbounded growth
}
```

#### Calculation Optimization
**Enhancement**: Single-pass processing for better memory efficiency
```typescript
// lib/statistics-utils.ts:369-423
for (let i = 0; i < entries.length; i++) {
  // Single-pass aggregation without intermediate arrays
}
```

## Code Analysis and Architecture

### 1. Driver Architecture

#### Local Driver (MarstekVenusDriver)
**Location**: `drivers/marstek-venus/driver.ts`
**Responsibilities**:
- UDP socket management
- Device discovery and pairing
- Command execution and polling
- Flow card registration

**Key Features**:
- Dynamic port binding to avoid conflicts
- Broadcast and unicast communication
- Retry mechanisms for reliability
- Flow card integration for user control

#### Cloud Driver (MarstekVenusCloudDriver)
**Location**: `drivers/marstek-venus-cloud/driver.ts`
**Responsibilities**:
- Cloud API authentication
- Device listing and management
- Credential caching and reuse
- Flow card registration

**Key Features**:
- MD5 password hashing
- Token-based authentication
- Device credential management
- Cloud API integration

### 2. Device Implementation

#### Local Device (MarstekVenusDevice)
**Location**: `drivers/marstek-venus/device.ts`
**Responsibilities**:
- Real-time data processing
- Capability updates
- Statistics collection
- Flow trigger execution

**Key Features**:
- UDP message handling
- Firmware-aware data scaling
- Statistics accumulation
- Profit calculation
- Flow integration

#### Cloud Device (MarstekVenusCloudDevice)
**Location**: `drivers/marstek-venus-cloud/device.ts`
**Responsibilities**:
- Cloud API polling
- Data synchronization
- Statistics management
- Flow trigger execution

**Key Features**:
- HTTP API polling
- Memory-optimized statistics
- Financial calculations
- Export functionality

### 3. Library Architecture

#### Marstek API (lib/marstek-api.ts)
**Purpose**: UDP socket management and communication
**Key Features**:
- Dynamic port binding
- Broadcast support
- Message parsing
- Error handling

#### Marstek Cloud (lib/marstek-cloud.ts)
**Purpose**: Cloud API communication and authentication
**Key Features**:
- Token management
- Device listing
- Status polling
- Error recovery

#### Statistics Utils (lib/statistics-utils.ts)
**Purpose**: Statistics collection and financial calculations
**Key Features**:
- Energy calculation
- Profit/savings calculation
- Data aggregation
- Memory management
- Audit trail

#### Financial Calculator (lib/financial-calculator.ts)
**Purpose**: Precision financial calculations with safety features
**Key Features**:
- Banker's rounding
- Zero division protection
- Precision loss detection
- Memory monitoring
- Outlier detection

#### Grid Counter Accumulator (lib/grid-counter-accumulator.ts)
**Purpose**: Convert cumulative counters to interval deltas
**Key Features**:
- Reset protection
- Out-of-order handling
- Deterministic flushing
- Authoritative counter handling

### 4. Configuration Management

#### Config (lib/config.ts)
**Purpose**: Application configuration and version management
**Key Features**:
- Version detection
- Debug mode management
- Feature flags
- Environment detection

#### Settings Integration
**Capabilities**:
- Energy price configuration
- Polling interval settings
- Statistics retention settings
- Debug mode toggles
- Network configuration

## Recommendations

### 1. Immediate Enhancements

#### Implement Missing API Calls
- Add `PV.GetStatus` support for Venus D models
- Implement `BLE.GetStatus` for connectivity monitoring
- Enhance `Marstek.GetDevice` for feature detection

#### Add Missing Capabilities
- Battery health monitoring capabilities
- Advanced power quality measurements
- Device diagnostic alarms
- Enhanced financial metrics

### 2. Medium-term Improvements

#### Enhanced Statistics
- Implement efficiency calculations
- Add self-discharge rate tracking
- Create carbon offset calculations
- Add peak shaving metrics

#### Advanced Control
- Implement target SOC control
- Add charge/discharge power limits
- Create time-of-use optimization
- Add grid interaction modes

### 3. Long-term Architecture

#### Scalability Improvements
- Implement database storage for statistics
- Add multi-device coordination
- Create historical data analysis
- Implement predictive features

#### Integration Enhancements
- Add solar panel integration
- Implement smart home ecosystem integration
- Create energy management automation
- Add advanced reporting features

### 4. Quality Improvements

#### Testing and Validation
- Add comprehensive unit tests
- Implement integration tests
- Create performance benchmarks
- Add security validation

#### Documentation and Support
- Create detailed user documentation
- Add developer API documentation
- Implement troubleshooting guides
- Create configuration examples

## Conclusion

The Marstek Battery Connector application demonstrates a well-architected implementation of the Marstek Device Open API with comprehensive error handling, financial calculations, and statistics management. The codebase shows significant improvements in precision, memory management, and reliability.

Key strengths include:
- Robust financial calculation system with banker's rounding
- Comprehensive error handling and graceful degradation
- Memory-optimized statistics collection
- Firmware-aware data scaling
- Extensive audit trail for debugging

Areas for enhancement focus on implementing missing API calls, adding advanced capabilities, and improving scalability. The architecture provides a solid foundation for future enhancements while maintaining reliability and performance.

The mapping document serves as a comprehensive reference for understanding the relationship between the Marstek API specifications and the Homey device implementation, enabling future development and maintenance efforts.