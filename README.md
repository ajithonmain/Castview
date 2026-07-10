# Castview

Mirror a laptop's screen (Windows or Mac) to a browser on any device on the same network — no admin rights, no app install on the viewer side, no capture card.

## Requirements
- Node.js installed on the laptop being mirrored
- No admin/sudo rights needed, no build tools required (pure-JS dependencies only)

## Setup
```bash
npm install
```
This installs pure-JS dependencies only — no native build step.

## Run
```bash
node server.js
```
On startup, Castview prints the local network addresses to use, for example:
```
Castview server running
Port: 8080
Open one of these on your tablet/phone browser:
  http://192.168.1.42:8080   (en0)
```

## Viewing
Open the printed address in a browser (Chrome recommended) on your tablet, phone, or another laptop — no app install required.

## Network Setup
- **WiFi (same network):** connect both devices to the same WiFi, use the printed IP.
- **USB tethering (Android → Windows):** enable USB tethering on the tablet; Windows auto-creates an RNDIS network adapter — use the IP printed for that adapter.
- **USB tethering (Windows → Android, reverse):** some tablets support "USB reverse tethering" via apps like NetShare — optional alternative.
- **Mac side:** works unchanged. `screenshot-desktop` will trigger a macOS Screen Recording permission prompt on first run — this is a one-time OS-level permission grant, not an install.

## Notes
- Audio mirroring is out of scope.
- Only the primary display is captured.
- Remote control (mouse/keyboard passthrough) is a phase 2 feature, not implemented yet.
