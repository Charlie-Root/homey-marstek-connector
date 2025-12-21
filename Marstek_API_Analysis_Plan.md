# Marstek Device Open API Analysis Plan

## Overview

This document provides a comprehensive analysis of the Marstek Device Open API (Rev 1.0) for integration with the Homey Marstek Battery Connector app. The analysis extracts all API endpoints, categorizes functionality, and provides technical specifications for implementation.

## API Protocol Analysis

### Protocol Format
- **Format**: JSON-RPC 2.0 over UDP
- **Encoding**: UTF-8
- **Transport**: UDP broadcast and unicast
- **Port**: Default 30000 (configurable 49152-65535)

### Message Structure

#### Request Format
```json
{
  "id": 0,
  "method": "string",
  "params": {
    "id": 0
  }
}
```

#### Response Format
```json
{
  "id": 0,
  "src": "device_identifier",
  "result": {
    "id": 0
  }
}
```

#### Error Format
```json
{
  "id": 0,
  "src": "device",
  "error": {
    "code": -32700,
    "message": "Parse error"
  }
}
```

### Error Codes
- **-32700**: Parse error
- **-32600**: Invalid Request
- **-32601**: Method not found
- **-32602**: Invalid params
- **-32603**: Internal error
- **-32000 to -32099**: Server errors (implementation-defined)

## API Components Analysis

### 1. Marstek Component (Discovery)

#### Marstek.GetDevice
- **Purpose**: Device discovery and identification
- **Method**: `Marstek.GetDevice`
- **Parameters**:
  - `ble_mac`: string (Valid MAC address, can be "0" for broadcast)
- **Response**:
  - `device`: string (Device model)
  - `ver`: number (Firmware version)
  - `ble_mac`: string (Bluetooth MAC)
  - `wifi_mac`: string (WiFi MAC)
  - `wifi_name`: string (WiFi SSID)
  - `ip`: string (Device IP address)
- **Usage**: Initial device discovery, broadcast to find devices on LAN

### 2. WiFi Component (Network Information)

#### Wifi.GetStatus
- **Purpose**: Retrieve WiFi connection status and network configuration
- **Method**: `Wifi.GetStatus`
- **Parameters**:
  - `id`: number (Instance ID)
- **Response**:
  - `id`: number (Instance ID)
  - `wifi_mac`: string (WiFi MAC address)
  - `ssid`: string or null (WiFi network name)
  - `rssi`: number (WiFi signal strength in dBm)
  - `sta_ip`: string or null (Device IP address)
  - `sta_gate`: string or null (Gateway IP)
  - `sta_mask`: string or null (Subnet mask)
  - `sta_dns`: string or null (DNS server)
- **Usage**: Monitor WiFi connectivity, network configuration

### 3. Bluetooth Component (BLE Information)

#### BLE.GetStatus
- **Purpose**: Check Bluetooth connection status
- **Method**: `BLE.GetStatus`
- **Parameters**:
  - `id`: number (Instance ID)
- **Response**:
  - `id`: number (Instance ID)
  - `state`: string (Bluetooth state: "connect", "disconnect", etc.)
  - `ble_mac`: string (Bluetooth MAC address)
- **Usage**: Monitor Bluetooth connectivity status

### 4. Battery Component (Battery Status)

#### Bat.GetStatus
- **Purpose**: Query battery information and operating status
- **Method**: `Bat.GetStatus`
- **Parameters**:
  - `id`: number (Instance ID)
- **Response**:
  - `id`: number (Instance ID)
  - `soc`: string (State of Charge percentage)
  - `charg_flag`: boolean (Charging permission flag)
  - `dischrg_flag`: boolean (Discharge permission flag)
  - `bat_temp`: number or null (Battery temperature in °C)
  - `bat_capacity`: number or null (Battery remaining capacity in Wh)
  - `rated_capacity`: number or null (Battery rated capacity in Wh)
- **Usage**: Monitor battery health, charge status, temperature

### 5. PV Component (Photovoltaic Information)

#### PV.GetStatus
- **Purpose**: Query photovoltaic charging information
- **Method**: `PV.GetStatus`
- **Parameters**:
  - `id`: number (Instance ID)
- **Response**:
  - `id`: number (Instance ID)
  - `pv_power`: number (Photovoltaic charging power in W)
  - `pv_voltage`: number (Photovoltaic charging voltage in V)
  - `pv_current`: number (Photovoltaic charging current in A)
- **Usage**: Monitor solar panel performance and charging

### 6. ES Component (Energy System - Core)

#### ES.GetStatus
- **Purpose**: Query basic electrical energy information and statistics
- **Method**: `ES.GetStatus`
- **Parameters**:
  - `id`: number (Instance ID)
- **Response**:
  - `id`: number (Instance ID)
  - `bat_soc`: number or null (Total battery SOC in %)
  - `bat_cap`: number or null (Total battery capacity in Wh)
  - `pv_power`: number or null (Solar charging power in W)
  - `ongrid_power`: number or null (Grid-tied power in W)
  - `offgrid_power`: number or null (Off-grid power in W)
  - `bat_power`: number or null (Battery power in W)
  - `total_pv_energy`: number or null (Total solar energy generated in Wh)
  - `total_grid_output_energy`: number or null (Total grid output energy in Wh)
  - `total_grid_input_energy`: number or null (Total grid input energy in Wh)
  - `total_load_energy`: number or null (Total load energy consumed in Wh)
- **Usage**: Primary data source for energy monitoring and statistics

#### ES.SetMode
- **Purpose**: Configure device operating mode
- **Method**: `ES.SetMode`
- **Parameters**:
  - `id`: number (Instance ID)
  - `config`: object (Configuration parameters)
    - `mode`: string (Operating mode: "Auto", "AI", "Manual", "Passive")
    - `auto_cfg`: object (Auto mode configuration)
      - `enable`: number (ON: 1, OFF: 0)
    - `ai_cfg`: object (AI mode configuration)
      - `enable`: number (ON: 1, OFF: 0)
    - `manual_cfg`: object (Manual mode configuration)
      - `time_num`: number (Time period serial number, 0-9)
      - `start_time`: string (Start time HH:MM)
      - `end_time`: string (End time HH:MM)
      - `week_set`: number (Week bitmask, 127 = all days)
      - `power`: number (Setting power in W)
      - `enable`: number (ON: 1, OFF: 0)
    - `passive_cfg`: object (Passive mode configuration)
      - `power`: number (Setting power in W)
      - `cd_time`: number (Power countdown in seconds)
- **Response**:
  - `id`: number (Instance ID)
  - `set_result`: boolean (Success status)
- **Usage**: Control device operating modes, scheduling

#### ES.GetMode
- **Purpose**: Get current operating mode information
- **Method**: `ES.GetMode`
- **Parameters**:
  - `id`: number (Instance ID)
- **Response**:
  - `id`: number (Instance ID)
  - `mode`: string (Current mode: "Auto", "AI", "Manual", "Passive")
  - `ongrid_power`: number or null (Grid-tied power in W)
  - `offgrid_power`: number or null (Off-grid power in W)
  - `bat_soc`: number or null (Battery SOC in %)
- **Usage**: Monitor current operating mode and status

### 7. EM Component (Energy Meter)

#### EM.GetStatus
- **Purpose**: Query energy meter status and power measurement data
- **Method**: `EM.GetStatus`
- **Parameters**:
  - `id`: number (Instance ID)
- **Response**:
  - `id`: number (Instance ID)
  - `ct_state`: number (CT status: 0=Not connected, 1=Connected)
  - `a_power`: number or null (Phase A power in W)
  - `b_power`: number or null (Phase B power in W)
  - `c_power`: number or null (Phase C power in W)
  - `total_power`: number or null (Total power in W)
- **Usage**: Monitor three-phase power measurements, CT status

## Device Support Matrix

### Venus C/E Models
- **Marstek**: ✓ Device discovery
- **WiFi**: ✓ Network information
- **Bluetooth**: ✓ BLE status
- **Battery**: ✓ Battery status
- **ES**: ✓ Energy system (core functionality)
- **EM**: ✓ Energy meter

### Venus D Model
- **Marstek**: ✓ Device discovery
- **WiFi**: ✓ Network information
- **Bluetooth**: ✓ BLE status
- **Battery**: ✓ Battery status
- **PV**: ✓ Photovoltaic information
- **ES**: ✓ Energy system (core functionality)
- **EM**: ✓ Energy meter

## API Dependencies and Sequencing

### Discovery Sequence
1. **Marstek.GetDevice** (broadcast)
   - Required for initial device identification
   - Returns device model and firmware version
   - Used to determine supported API methods

### Configuration Dependencies
1. **WiFi.GetStatus** depends on:
   - Device being powered and connected to WiFi
   - Open API feature enabled in Marstek app

2. **ES.SetMode** requires:
   - Valid device identification (from Marstek.GetDevice)
   - Device being online and responsive

### Data Collection Dependencies
1. **ES.GetStatus** provides:
   - Primary energy data for statistics
   - Grid import/export counters for financial calculations
   - Battery status for charge/discharge tracking

2. **EM.GetStatus** provides:
   - Three-phase power measurements
   - CT status for grid connection monitoring

## Implementation Mapping to Homey Capabilities

### Current Local Driver (marstek-venus)
- **Capabilities**: 24 capabilities implemented
- **API Methods Used**:
  - ES.GetStatus (primary data source)
  - ES.GetMode (mode monitoring)
  - EM.GetStatus (power measurements)
  - WiFi.GetStatus (network status)
  - Bat.GetStatus (battery status)
  - ES.SetMode (mode control via flow cards)

### Current Cloud Driver (marstek-venus-cloud)
- **Capabilities**: 14 capabilities implemented
- **API Methods Used**: None (uses cloud API, not local UDP)
- **Data Source**: Marstek cloud service via HTTPS

### Missing API Integration Opportunities

#### PV Component Integration
- **Current Status**: Not implemented in local driver
- **Potential Capabilities**:
  - `measure_power_pv` (already exists, could use PV.GetStatus)
  - Solar generation monitoring
  - PV efficiency tracking

#### Enhanced EM Component Integration
- **Current Status**: Partially implemented
- **Enhancement Opportunities**:
  - Three-phase power monitoring per phase
  - CT status monitoring and alerts
  - Enhanced grid connection status

#### Advanced ES Component Features
- **Current Status**: Basic implementation
- **Enhancement Opportunities**:
  - Manual mode scheduling via UI
  - AI mode status monitoring
  - Passive mode countdown monitoring

## Technical Implementation Notes

### UDP Communication
- **Broadcast Discovery**: Port 30000, broadcast to 255.255.255.255
- **Unicast Communication**: Direct to device IP on port 30000
- **Message ID**: 16-bit integer, should be unique per request
- **Timeout**: 10 seconds recommended for responses

### Data Processing
- **Firmware Version**: Used to determine data scaling (divisor values)
- **Energy Counters**: Raw values need scaling (typically /10 or /100)
- **Power Measurements**: Real-time values, no scaling required
- **Temperature**: May need scaling based on firmware version

### Error Handling
- **Network Errors**: Retry mechanism recommended
- **Invalid Responses**: Graceful degradation
- **Timeout Handling**: Device status updates
- **Firmware Compatibility**: Version-specific parsing

## Future Enhancement Opportunities

### 1. Enhanced Statistics
- **Grid Counter Integration**: Use EM.GetStatus for precise grid measurements
- **PV Generation Tracking**: Implement solar generation statistics
- **Three-Phase Analysis**: Detailed phase-by-phase monitoring

### 2. Advanced Control Features
- **Manual Mode Scheduling**: UI-based schedule configuration
- **AI Mode Monitoring**: AI algorithm status and performance
- **Passive Mode Automation**: Countdown-based automation triggers

### 3. Diagnostic Capabilities
- **CT Status Monitoring**: Grid connection health monitoring
- **WiFi Signal Quality**: Network connectivity alerts
- **Battery Health Tracking**: Long-term battery performance analysis

### 4. Integration Improvements
- **Unified API Layer**: Common interface for local and cloud drivers
- **Configuration Management**: Centralized device configuration
- **Firmware Detection**: Automatic feature detection based on firmware version

## Conclusion

The Marstek Device Open API provides comprehensive access to device functionality with 7 main components and 10 distinct API methods. The current Homey implementation utilizes approximately 60% of available functionality, with significant opportunities for enhancement in PV monitoring, advanced EM features, and enhanced ES control capabilities.

The API is well-structured for Homey integration with clear data types, consistent response formats, and robust error handling. Future development should focus on leveraging the full API potential while maintaining backward compatibility and device-specific feature detection.