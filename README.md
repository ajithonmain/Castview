# Castview

[![npm version](https://img.shields.io/npm/v/castview)](https://www.npmjs.com/package/castview)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

Mirror a computer's screen to any device with a browser — phone, tablet, or another computer. One command on the host, one QR scan on the viewer. Nothing to install on the viewing device, no admin rights, no accounts, no cloud.

Castview was built as a rescue tool for a laptop with a dead display: if the machine has Node.js and you have a USB cable, you have a screen again. It works just as well for everyday sharing — showing your screen to a tablet on your desk, a TV browser, or a colleague's laptop on the same network.

## Quick start

```bash
npx castview
```

That's it. Castview:

1. starts sharing your screen on your local network,
2. opens a setup page in your browser with QR codes,
3. adds a launcher to your Desktop so next time is a double-click.

Point a phone or tablet camera at a QR code, type the session PIN shown on the setup page, and the live screen opens in its browser.

Permanent install, if you prefer:

```bash
npm install -g castview
castview
```

## Requirements

- **Node.js 18+** on the computer being shared. That's the only hard requirement.
- **ffmpeg** (optional, recommended): enables smooth ~15 fps streaming with the cursor visible. Without it Castview falls back to a basic screenshot loop, which works but looks choppy. Any ffmpeg on PATH is fine — a portable build in a folder works, no installer or admin rights needed.

The viewing device needs only a browser (Chrome, Safari, Edge, Firefox).

## Connection options

**WiFi** — both devices on the same network. Scan the QR code from the setup page or the terminal.

**USB cable** — no WiFi needed. Plug the phone/tablet into the computer and enable USB tethering on it (Settings, search "tethering"). The setup page detects the new connection within seconds and shows a QR code for it — no restart required.

## The viewer

Open the QR link and you get a full-screen live view with a small control pill in the bottom-left corner:

- **Quality: HD / Fast** — HD streams up to 1600px-wide frames; Fast sends much smaller frames for weak WiFi or lower latency.
- **Rotate** — turns the picture 90 degrees, for holding a phone in portrait while viewing a landscape screen.
- **Full screen** — with automatic landscape orientation lock where the browser supports it.

The viewer auto-reconnects if the connection drops, keeps the device awake while watching, and supports pinch-to-zoom. On iPhone (no fullscreen API), add the page to your Home Screen for a fullscreen experience.

## The setup page

`http://localhost:8080/host` on the shared computer (opens automatically on start):

- QR codes and addresses for every network you're on, labelled WiFi / USB, updating live
- The session PIN
- **Low latency mode** toggle — the setup tab captures the screen itself and streams WebRTC directly to viewers at ~30 fps with a fraction of the delay. Viewers switch over automatically and fall back to the JPEG stream if the tab closes. Keep the tab open while it runs.
- **Scan now** button on the USB card — re-detects a freshly plugged-in phone, and tells you when a device is connected but hasn't been assigned an address yet
- **Stop sharing** button — shuts the server down, no terminal needed
- **Desktop shortcut** button — re-adds the launcher if you removed it
- A warning banner if ffmpeg is missing

## Security

- Every session generates a **random 4-digit PIN**. Every viewer types it once in their browser; QR codes and printed URLs deliberately do not embed it, and the PIN is shown only on the shared computer itself.
- The stream never leaves your local network. No cloud, no telemetry.
- Stop and shortcut endpoints only accept requests from the shared computer.

This is LAN-convenience security, not cryptography: the stream is plain HTTP on your own network. Don't use it on networks you don't trust.

## Configuration

All optional, via environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | HTTP/WebSocket port. If another app holds it, the next free port is used automatically; if another Castview holds it, its setup page opens instead |
| `FPS` | `15` | Target frame rate |
| `PIN` | random | Fixed access PIN, or `PIN=off` to disable |
| `QUALITY` | `sharp` | Starting quality: `sharp` (HD) or `smooth` (Fast) |
| `SCREEN` | `0` | Display index to capture (macOS) |
| `NO_OPEN` | unset | `1` skips auto-opening the setup page |
| `NO_SHORTCUT` | unset | `1` skips creating the desktop launcher on first run |

Flags:

- `--no-pin` — disable the PIN. Essential for the blind-rescue case: when the host screen is dead you can't read a random PIN, so type `npx castview --no-pin` blind and open the printed-style address from the viewer.

Examples:

```bash
FPS=30 PIN=1234 npx castview
npx castview --no-pin
```

## Platform notes

- **macOS** — first run asks for Screen Recording permission (System Settings → Privacy & Security). One-time OS prompt, not an install. The desktop launcher is a real .app with the Castview icon that starts sharing in the background.
- **Windows** — runs without admin. Capture uses ffmpeg's `gdigrab`; the launcher is a `.lnk` that starts Castview hidden.
- **Linux** — X11 capture via ffmpeg's `x11grab`; the launcher is a `.desktop` entry.

## How it works

```
[Shared computer]                        [Any browser]
  castview (Node)                          scan QR / open URL
  ├─ ffmpeg captures the screen            └─ live view, ~15 fps
  │  as an MJPEG stream (cursor included)
  ├─ frames pushed over WebSocket
  └─ serves the viewer + setup pages
```

Deliberately simple: JPEG frames over a WebSocket, decodable by any browser with zero client code beyond one HTML page. No codecs to install, no build step — the dependencies are pure JavaScript.

When **low latency mode** is on, the setup tab captures the screen with `getDisplayMedia` and streams WebRTC video peer-to-peer over the LAN; the Node server only relays the signaling. Viewers use it automatically when available and fall back to the JPEG stream when it isn't.

## Roadmap

- Remote control from the viewer (mouse/keyboard passthrough)
- Multi-monitor picker on the setup page

Issues and PRs welcome: [github.com/ajithonmain/Castview](https://github.com/ajithonmain/Castview)

## License

[MIT](LICENSE) — built by [Ajith M Jose](https://ajithmjose.com)
