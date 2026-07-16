# Marstek Venus Connector

This Homey app connects to a Marstek Venus battery system through the local network, over Bluetooth (BLE), or via the Marstek cloud service and retrieves battery statistics. It allows you to monitor the battery status, charge level, and other relevant information directly from your Homey smart home system. Using flows you can send commands to the battery to change mode (local API and Bluetooth). There is an auto-detect algorithm that tries to find your Marstek Venus batteries.

## FEATURES

When a device is detected and communication is working, the device will display various statistics such as:
- Battery charge level
- Status (charging, discharging, idle)
- Power left (in kilowatts/hours)
- Grid/Off-grid power
- Current power output or intake (Watt)
- Battery Temperature
- Charge and discharge totals (kWh)

You can also send commands to the battery to change the operating mode to 'Manual', 'AI', 'Passive' or 'Auto'. These commands can be transmitted using Homey flows ('Then...').

### BLUETOOTH DRIVER

The **Marstek Venus (Bluetooth)** driver talks to the battery directly over Bluetooth Low Energy, without any network configuration. It works out of the box (no Wi-Fi or Local API setup needed) and exposes richer telemetry read straight from the battery management system:

- State of Charge and **State of Health** (%)
- Battery power (from the BMS), on-grid and off-grid port power, and charging state
- Pack voltage and current
- Battery and MOSFET temperature
- Work mode and a fault (alarm) indicator, plus the raw BMS alarm code (with an "Alarm code changed" flow trigger providing error/warning code tags)
- Charge and discharge totals (kWh), plus today's charged/discharged energy
- Output power rating and Local API status (shown in device settings)

It also provides flow action cards to control the battery over Bluetooth: set the work mode (off/on), set the output power limit (800 W / 2500 W), set Depth of Discharge, enable/disable EPS/backup power, restart the battery, and — handy for bootstrapping the local network driver — **Enable/disable the Local API on port 30000**. Note that, unlike the Local API, Bluetooth cannot set a scheduled "Manual" mode (time window + power) — only the coarse work-mode toggle.

> Bluetooth connections are established on demand for each read/command and closed afterwards, because the battery accepts only one Bluetooth connection at a time. Keep the poll interval generous (default 60 s). The battery must be within Bluetooth range of your Homey.

## REQUIREMENTS

This app requires Homey and a Marstek Venus battery system.

- When using the **local API driver** the Homey and battery must be connected to the same network with the local API enabled (see below). Auto-detection of Marstek Venus batteries is supported on the same local network and when IP range is 192.168.x.y; it will search within the last octet (y) from 1 to 254.
- When using the **Bluetooth driver** the battery must be within Bluetooth range of your Homey. No network or Local API setup is required. During pairing Homey scans for nearby Marstek batteries; select the one you want to add.
- When using the **cloud driver** you need an active Marstek cloud/app account. During pairing Homey will ask for the username and password to authenticate with the Marstek cloud service.

### DEVICE PAIRING (CLOUD)

Choose the “Marstek Venus (Cloud)” device during pairing, sign in with your Marstek cloud credentials and select the site/device you want to add. Credentials are securely stored in the device store and used solely for refreshing the battery statistics from the Marstek cloud endpoints.

### DEVICE PAIRING (LOCAL API)

The Local API is disabled by default, this needs te be enabled on the Marstek Venus battery system. This can be done in two ways:
- Use the BLE Test Tool (https://rweijnen.github.io/marstek-venus-monitor/latest/) on your smartphone (or laptop) near the battery. Connect and use 'Enable Local API (30000)' button in 'System' tab.
- Contact Marstek support to have them enable the Local API for you. This can take a few days.

*The local API must be enabled for port number 30000 (on each device). Currently no other port numbers are supported.*

### DEVICE PAIRING (BLUETOOTH)

Choose the “Marstek Venus (Bluetooth)” device during pairing. Homey scans for nearby batteries advertising the Marstek Bluetooth service and lists them; select the battery you want to add. No network configuration is required. Tip: you can use the “Enable/disable Local API (BLE)” flow card afterwards to switch on the local UDP API over Bluetooth, so the “Marstek Venus (Local API)” driver can then discover the battery over the network.

## STEP BY STEP INSTRUCTIONS

1. Install the MarstekHomey app from the Homey App Store.
2. Add new device using Marstek Battery Connector
3. Select type of connection to make:
- For API: system will auto detect
- For Cloud: Enter your App/Cloud credentials and let it auto detect
4. Select/check all devices to add and click continue to add them to Homey.
5. Watch the magic happen as the battery statistics are retrieved and displayed in the device card(s).

You can devices from both API and Cloud. See settings of each battery for additional details. 

## VERSION HISTORY

- 0.10.1 - Added Bluetooth BLE driver for direct communication with the battery. Retrieval of battery statistics and sending commands to the battery is now possible over Bluetooth. Added flow cards for controlling the battery over Bluetooth.
- 0.9.0 - **[current LIVE release]** Updated LIVE version of app; all fixes and improvements from TEST version are now included in the LIVE version.
- 0.8.13 - Negative power values for passive mode flow card are now allowed. Updated module dependencies to latest versions and cleaned some code.
- 0.8.12 - Dependency updates. New Homey SDK. Added flow card for new 'UPS' battery mode (with enabled argument). Added flow card for setting LED display status (on/off) through local API.
- 0.8.11 - The stored IP address of local API devices are now shown in settings (read only).
- 0.8.10 - Applied corrections to default factors for hardware/firmware combinations, based on community feedback. Broadcast setting now default true during device discovery. Missing factors are now set to default when updating the app.
- 0.8.9 - Made all factors that are applied when receiving API data configurable. Also included default factors for different hardware and firmware versions.
- 0.8.8 - UDP broadcast or sending individual UDP packages to individual batteries is now configurable (defaults to broadcast).
- 0.8.7 - The 'ES.GetStatus' messages are no longer using UDP broadcast but now directly target the IP address of the device, sending out one request per device.
- 0.8.6 - Debugging added when message details source does not match configured source(s).
- 0.8.5 - Additional debugging logs added for improving Marstek Venus compatibility, only for TEST version of this app.
- 0.8.4 - Polling interval could not always be determined when upgrading the Homey app from previous versions, added a fallback interval value.
- 0.8.3 - Bug removed that caused no data to be processed from the local API. Debug flag is now always set for TEST versions fo the app.
- 0.8.2 - Default settings can be given during pairing of local API devices. Added escaping of strings during cloud login. Unique id for messages limited to 16bits integer.
- 0.8.1 - Added settings to disable polling for data from local API, but flows sending battery commands are still possible, to alleviate communication issues when used together with CT002/CT003.
- 0.8.0 - Code structure changes and github cleanup. Converted source to TypeScript only.
- 0.7.6 - Cloud data stopped updating when initial response of Marstek Cloud service was slow, causing a concurrency problem.
- 0.7.5 - Incorrect password for Marstek Cloud could not be corrected without removing app first. Technical errors on the Marstek Cloud service are not correctly caught.
- 0.7.4 - Temperature reported by same firmware has different multiplier; sanity calculation added. Marstek Cloud login problems were not handled correctly.
- 0.7.3 - Cloud login could fail for users with multiple devices. Added some translations.
- 0.7.2 - Temperature for firmware 154 was reported incorrectly. Added retry meganism to the flow cards that set battery mode. Improved readability of some library classes.
- 0.7.1 - Added flow card for changing the battery charging mode through local API.
- 0.7.0 - Added support for a Marstek cloud driver that retrieves battery statistics using your Marstek cloud account credentials.
(older history details are left out)

## NOTES

- This app uses the 'API over UDP' features as mentioned in the Marstek API documentation. 
- The app is developed and tested with a Venus E v2.0 battery system (firmware v153, communication module 202409090159). Let me know if any other models work as well!
- When the device can't be auto-detected, please check if the Marstek Venus battery is powered on and connected to the same network as Homey.
- Support for multiple Marstek Venus batteries is implemented, but since I only have one battery to test with, some is uncharted.
- Only UDP port 30000 is currently supported on the local API.
- When upgrading the app, it might be needed to remove already added battery devices first and then adding them again. 
- The Marstek Cloud API is undocumented, so things might change without notice.
- Battery mode changes have an automatic retry for a maximum of 5 tries with a 15 seconds timeout.
- The Bluetooth connection, commands and data retrieval is undocumented territory, so things might change without notice.

## KNOWN ISSUES

- Sometimes UDP communication stops after a while (without any exception, warning).
- Not all transmitted UDP packages are being answered by the battery (it is silently ignoring them).
- Does not seem to work well in conjuction with CT002 or CT003, battery seems to stop communicating. 
- Cloud data does not take back-up power port correctly into account (show 1 Watt)
- Using Cloud device seems to log-out app (single login token only allowed by Marstek)

# TROUBLESHOOTING

The local API of battery has some communication issues. Not all UDP messages are answered and there seem to be some conflicts when using other methods to communicate with the battery at the same time. The communication seems to deteriorate over time until it stops completely. Users with firmware 154 report less problems. Communication can be kick-started by using the BLE Test Tool (https://rweijnen.github.io/marstek-venus-monitor/latest/) v2.0 under the 'Advances' tab using the 'System Reset' function. Note that power delivery will be interrupted for a brief moment, and after that the communication stack will respond again to all messages.