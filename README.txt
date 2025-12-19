# Marstek Venus Connector

This Homey app connects to a Marstek Venus battery system either through the local network or via the Marstek cloud service and retrieves battery statistics. It allows you to monitor the battery status, charge level, and other relevant information directly from your Homey smart home system. Using flows you can send commands to the battery to change mode (local API only). There is an auto-detect algorithm that tries to find your Marstek Venus batteries.

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

## REQUIREMENTS

This app requires Homey and a Marstek Venus battery system.

- When using the **local API driver** the Homey and battery must be connected to the same network with the local API enabled (see below). Auto-detection of Marstek Venus batteries is supported on the same local network and when IP range is 192.168.x.y; it will search within the last octet (y) from 1 to 254.
- When using the **cloud driver** you need an active Marstek cloud/app account. During pairing Homey will ask for the username and password to authenticate with the Marstek cloud service.

### DEVICE PAIRING (CLOUD)

Choose the �Marstek Venus (Cloud)� device during pairing, sign in with your Marstek cloud credentials and select the site/device you want to add. Credentials are securely stored in the device store and used solely for refreshing the battery statistics from the Marstek cloud endpoints.

### DEVICE PAIRING (LOCAL API)

The Local API is disabled by default, this needs te be enabled on the Marstek Venus battery system. This can be done in two ways:
- Use the BLE Test Tool (https://rweijnen.github.io/marstek-venus-monitor/latest/) on your smartphone (or laptop) near the battery. Connect and use 'Enable Local API (30000)' button in 'System' tab.
- Contact Marstek support to have them enable the Local API for you. This can take a few days.

*The local API must be enabled for port number 30000 (on each device). Currently no other port numbers are supported.*

## STEP BY STEP INSTRUCTIONS

1. Install the MarstekHomey app from the Homey App Store.
2. Add new device using Marstek Battery Connector
3. Select type of connection to make:
- For API: system will auto detect
- For Cloud: Enter your App/Cloud credentials and let it auto detect
4. Select/check all devices to add and click continue to add them to Homey.
5. Watch the magic happen as the battery statistics are retrieved and displayed in the device card(s).

You can devices from both API and Cloud. See settings of each battery for additional details. 

## NOTES

- This app uses the 'API over UDP' features as mentioned in the API documentation. 
- The app is developed and tested with a Venus E v2.0 battery system (firmware v153, communication module 202409090159). Let me know if any other models work as well!
- When the device can't be auto-detected, please check if the Marstek Venus battery is powered on and connected to the same network as Homey.
- Support for multiple Marstek Venus batteries is implemented, but since I only have one battery to test with, some is uncharted.
- Only UDP port 30000 is currently supported on the local API.
- When upgrading the app, it might be needed to remove already added battery devices first and then adding them again. 
- The Marstek Cloud API is undocumented, so things might change without notice.
- Battery mode changes have an automatic retry for a maximum of 5 tries with a 15 seconds timeout.

## KNOWN ISSUES

- Sometimes UDP communication stops after a while (without any exception, warning).
- Not all transmitted UDP packages are being answered by the battery (it is silently ignoring them).
- Does not seem to work well in conjuction with CT002 or CT003, battery seems to stop communicating. 
- Cloud data does not take back-up power port correctly into account (show 1 Watt)
- Using Cloud device seems to log-out app (single login token only allowed by Marstek)

# TROUBLESHOOTING

The local API of battery has some communication issues. Not all UDP messages are answered and there seem to be some conflicts when using other methods to communicate with the battery at the same time. The communication seems to deteriorate over time until it stops completely. Users with firmware 154 report less problems. Communication can be kick-started by using the BLE Test Tool (https://rweijnen.github.io/marstek-venus-monitor/latest/) v2.0 under the 'Advances' tab using the 'System Reset' function. Note that power delivery will be interrupted for a brief moment, and after that the communication stack will respond again to all messages.