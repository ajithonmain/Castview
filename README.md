# Castview

Mirror a laptop's screen (Windows, Mac, or Linux) to any device with a browser — phone, tablet, another computer. No admin rights, nothing to install on the viewing device, no capture card.

Born from a real problem: a laptop with a broken display, and a tablet that could stand in as its screen.

## How it works

```
[Your computer]                        [Any device with a browser]
  node server.js                          scan QR / open URL
  ├─ captures the screen                  └─ live view of your screen
  ├─ streams JPEG frames over WebSocket
  └─ serves the viewer page
```

Everything stays on your local network. Nothing goes over the internet.

## Quick start

```bash
npx castview
```

Or from source:

```bash
git clone https://github.com/ajithonmain/Castview.git
cd Castview
npm install
node server.js
```

Your browser opens a setup page with QR codes. Scan one with your phone or tablet camera — the mirrored screen opens in its browser, already authenticated. That's it.

No admin/sudo needed, and dependencies are pure JavaScript — no build tools required on the machine.

## Requirements

- Node.js on the computer being mirrored
- **Optional but recommended:** [ffmpeg](https://ffmpeg.org) on PATH — enables smooth streaming (~15 fps with cursor). Without it, Castview falls back to a basic screenshot loop (choppier). A portable ffmpeg build in a folder on PATH works fine; no installer needed.

## Connection options

**WiFi (typical):** both devices on the same network. Scan the QR code from the setup page or terminal, or type the printed URL.

**USB cable (no WiFi):** connect the device with a USB cable and enable USB tethering on it (Settings → Hotspot & tethering). A new QR code appears on the setup page automatically — no restart needed.

## Configuration

Environment variables, all optional:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP/WebSocket port |
| `FPS` | `15` | Target frame rate |
| `PIN` | random | Access PIN; set a fixed one, or `PIN=off` to disable |
| `QUALITY` | `sharp` | `sharp` or `smooth` (smaller frames for weak WiFi) |
| `SCREEN` | `0` | Display index to capture (macOS) |
| `NO_OPEN` | unset | Set to `1` to skip auto-opening the setup page |

Example: `FPS=30 PIN=1234 npx castview`

Viewers can also toggle sharp/smooth live from a button in the viewer.

## Platform notes

- **macOS:** first run asks for Screen Recording permission (System Settings → Privacy & Security) — a one-time OS prompt, not an install.
- **Windows:** works without admin. For smooth mode, drop a portable `ffmpeg.exe` somewhere on PATH.
- **Linux:** X11 capture via ffmpeg (`x11grab`).

## Security note

Every session is protected by a random 4-digit PIN. QR codes embed it, so scanning connects directly; anyone typing the address by hand is asked for it. The PIN is only shown on the machine being mirrored. Stop the server (Ctrl+C) when you're done. Note this is LAN-convenience security, not cryptographic — the stream itself is unencrypted HTTP on your local network.

## Roadmap

- Viewer-side remote control (mouse/keyboard passthrough)
- Multi-monitor picker in the setup page
- Audio (out of scope for now)

## License

[MIT](LICENSE)
