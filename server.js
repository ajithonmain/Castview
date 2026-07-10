#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');
const WebSocket = require('ws');
const screenshot = require('screenshot-desktop');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 8080;
const FPS = Number(process.env.FPS) || 15;
const SCREEN = Number(process.env.SCREEN) || 0;

// Access PIN: viewers must present it to receive the stream. QR codes embed
// it, so scanning just works; manual typers enter it once. Disable with
// --no-pin or PIN=off — essential when the host screen is dead and the PIN
// can't be read.
const PIN = process.argv.includes('--no-pin') || process.env.PIN === 'off' ? null
  : process.env.PIN || String(Math.floor(1000 + Math.random() * 9000));

// Quality presets, switchable live from the viewer.
const QUALITY_PRESETS = {
  sharp: { maxWidth: 1920, q: 4 },
  smooth: { maxWidth: 1100, q: 12 },
};
let quality = process.env.QUALITY === 'smooth' ? 'smooth' : 'sharp';

const viewerHtml = fs.readFileSync(path.join(__dirname, 'viewer.html'));
const hostHtml = fs.readFileSync(path.join(__dirname, 'host.html'));
const logoPng = fs.readFileSync(path.join(__dirname, 'assets', 'logo.png'));

// --- HTTP ---

function isLocalRequest(req) {
  const addr = req.socket.remoteAddress || '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(viewerHtml);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/host') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(hostHtml);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/logo.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'max-age=86400' });
    res.end(logoPng);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/info') {
    Promise.all(
      getLocalIps().map(async ({ name, address }) => {
        const viewUrl = `http://${address}:${PORT}${PIN ? `/?pin=${PIN}` : ''}`;
        const qrSvg = await QRCode.toString(viewUrl, { type: 'svg', margin: 1 });
        const { kind, label } = classifyInterface(name);
        return { name, address, url: viewUrl, qrSvg, kind, label };
      })
    )
      .then((interfaces) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          port: PORT,
          interfaces,
          ffmpeg: useFfmpeg,
          viewers: wss.clients.size,
          // Only reveal the PIN to the machine being mirrored.
          pin: isLocalRequest(req) ? PIN : undefined,
        }));
      })
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      });
    return;
  }
  // Create a double-clickable launcher on the Desktop for easy relaunching.
  if (req.method === 'POST' && url.pathname === '/api/shortcut') {
    if (!isLocalRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    try {
      const file = createDesktopShortcut();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, path: file }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  // Stop sharing from the setup page. Only the mirrored machine may call it.
  if (req.method === 'POST' && url.pathname === '/api/stop') {
    if (!isLocalRequest(req)) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'forbidden' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }), () => {
      console.log('Stopped from setup page');
      stopCapture();
      process.exit(0);
    });
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// --- WebSocket + auth ---

const wss = new WebSocket.Server({ server });

function authedClients() {
  return [...wss.clients].filter((c) => c.authed);
}

function broadcast(frame) {
  for (const client of wss.clients) {
    // Skip clients that haven't drained the previous frame yet, so a slow
    // viewer lags instead of building up a growing backlog of stale frames.
    if (client.authed && client.readyState === WebSocket.OPEN && client.bufferedAmount === 0) {
      client.send(frame, { binary: true });
    }
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url, 'http://x');
  ws.authed = !PIN || url.searchParams.get('pin') === PIN;
  if (!ws.authed) {
    ws.close(4001, 'invalid pin');
    return;
  }

  console.log('Viewer connected');
  startCapture();

  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'quality' && QUALITY_PRESETS[msg.value] && msg.value !== quality) {
        quality = msg.value;
        console.log(`Quality changed to ${quality}`);
        if (useFfmpeg) {
          stopFfmpeg();
          startFfmpeg();
        }
      }
    } catch {}
  });

  ws.on('close', () => {
    console.log('Viewer disconnected');
    if (authedClients().length === 0) stopCapture();
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// --- ffmpeg capture (preferred): continuous MJPEG stream, smooth frame rate ---

function hasFfmpeg() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function ffmpegInputArgs() {
  if (process.platform === 'darwin') {
    return ['-f', 'avfoundation', '-capture_cursor', '1', '-pixel_format', 'uyvy422', '-framerate', String(FPS), '-i', `Capture screen ${SCREEN}`];
  }
  if (process.platform === 'win32') {
    return ['-f', 'gdigrab', '-framerate', String(FPS), '-draw_mouse', '1', '-i', 'desktop'];
  }
  return ['-f', 'x11grab', '-framerate', String(FPS), '-i', process.env.DISPLAY || ':0'];
}

let ffmpegProc = null;
let ffmpegRestartTimer = null;

function startFfmpeg() {
  if (ffmpegProc) return;
  const { maxWidth, q } = QUALITY_PRESETS[quality];
  const args = [
    '-loglevel', 'error',
    ...ffmpegInputArgs(),
    '-vf', `scale='min(${maxWidth},iw)':-2`,
    // avfoundation's screen device reports a bogus huge timebase; without an
    // explicit output rate ffmpeg duplicates frames as fast as CPU allows.
    '-r', String(FPS),
    '-q:v', String(q),
    '-f', 'mjpeg',
    'pipe:1',
  ];
  const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  ffmpegProc = proc;

  // Extract complete JPEGs from the MJPEG byte stream (SOI ffd8 .. EOI ffd9).
  let buf = Buffer.alloc(0);
  proc.stdout.on('data', (chunk) => {
    // A replaced process (quality switch) may still flush frames while dying;
    // drop them so two encoders never interleave.
    if (ffmpegProc !== proc) return;
    buf = Buffer.concat([buf, chunk]);
    let start;
    while ((start = buf.indexOf('\xff\xd8', 0, 'binary')) !== -1) {
      const end = buf.indexOf('\xff\xd9', start + 2, 'binary');
      if (end === -1) break;
      broadcast(buf.subarray(start, end + 2));
      buf = buf.subarray(end + 2);
    }
    // Cap the parse buffer so a marker-scan miss can't grow it unbounded.
    if (buf.length > 32 * 1024 * 1024) buf = Buffer.alloc(0);
  });

  proc.stderr.on('data', (d) => console.error('ffmpeg:', d.toString().trim()));

  proc.on('exit', (code) => {
    // If we were replaced or deliberately stopped, ffmpegProc no longer
    // points at us — that exit is expected, don't null the new process or
    // schedule a restart. (ffmpeg traps SIGTERM and exits code 255 with no
    // signal, so exit codes can't distinguish our kill from a crash.)
    if (ffmpegProc !== proc) return;
    ffmpegProc = null;
    if (authedClients().length > 0) {
      console.error(`ffmpeg exited (code ${code}), restarting in 1s`);
      ffmpegRestartTimer = setTimeout(() => {
        ffmpegRestartTimer = null;
        if (authedClients().length > 0) startCapture();
      }, 1000);
    }
  });

  console.log('Capture: ffmpeg MJPEG stream');
}

function stopFfmpeg() {
  if (ffmpegRestartTimer) {
    clearTimeout(ffmpegRestartTimer);
    ffmpegRestartTimer = null;
  }
  if (!ffmpegProc) return;
  const proc = ffmpegProc;
  ffmpegProc = null;
  proc.kill('SIGTERM');
}

// --- screenshot fallback: used when ffmpeg is not installed ---

const darwinFramePath = path.join(os.tmpdir(), `castview-frame-${process.pid}.jpg`);

function captureFrame() {
  if (process.platform === 'darwin') {
    return new Promise((resolve, reject) => {
      execFile('screencapture', ['-x', '-C', '-t', 'jpg', darwinFramePath], (err) => {
        if (err) return reject(err);
        fs.readFile(darwinFramePath, (err, buf) => (err ? reject(err) : resolve(buf)));
      });
    });
  }
  return screenshot({ format: 'jpg', screen: SCREEN || undefined });
}

let captureTimer = null;
let capturing = false;

async function captureAndBroadcast() {
  if (capturing) return;
  capturing = true;
  try {
    broadcast(await captureFrame());
  } catch (err) {
    console.error('Capture failed:', err.message);
    if (process.platform === 'darwin') {
      console.error('If this persists, grant Screen Recording permission: System Settings > Privacy & Security > Screen Recording');
    }
  } finally {
    capturing = false;
  }
}

function startScreenshotLoop() {
  if (captureTimer) return;
  captureTimer = setInterval(captureAndBroadcast, 1000 / FPS);
  console.log('Capture: screenshot loop (install ffmpeg for smoother streaming)');
}

function stopScreenshotLoop() {
  if (!captureTimer) return;
  clearInterval(captureTimer);
  captureTimer = null;
}

// --- capture lifecycle: run only while viewers are connected ---

const useFfmpeg = hasFfmpeg();

function startCapture() {
  if (useFfmpeg) startFfmpeg();
  else startScreenshotLoop();
}

function stopCapture() {
  stopFfmpeg();
  stopScreenshotLoop();
}

// --- network interfaces ---

// Classify each network interface as wifi / usb / ethernet so the setup page
// can tell the user which QR belongs to which connection path.

let darwinPortCache = { at: 0, map: {} };

function darwinPortMap() {
  if (Date.now() - darwinPortCache.at < 10000) return darwinPortCache.map;
  try {
    const out = execFileSync('networksetup', ['-listallhardwareports'], { encoding: 'utf8' });
    const map = {};
    let port = null;
    for (const line of out.split('\n')) {
      const p = line.match(/^Hardware Port: (.+)$/);
      if (p) { port = p[1].trim(); continue; }
      const d = line.match(/^Device: (.+)$/);
      if (d && port) map[d[1].trim()] = port;
    }
    darwinPortCache = { at: Date.now(), map };
  } catch {
    darwinPortCache = { at: Date.now(), map: {} };
  }
  return darwinPortCache.map;
}

function classifyInterface(name) {
  if (process.platform === 'darwin') {
    const port = darwinPortMap()[name] || name;
    if (/wi-?fi|airport/i.test(port)) return { kind: 'wifi', label: 'WiFi' };
    if (/ethernet|thunderbolt|bridge|lan/i.test(port)) return { kind: 'ethernet', label: port };
    // Tethered phones show up under their device name, e.g. "Pixel 10 Pro"
    return { kind: 'usb', label: port };
  }
  if (process.platform === 'win32') {
    if (/wi-?fi|wireless|wlan/i.test(name)) return { kind: 'wifi', label: 'WiFi' };
    if (/ndis|tether|usb/i.test(name)) return { kind: 'usb', label: name };
    return { kind: 'ethernet', label: name };
  }
  if (/^wl/i.test(name)) return { kind: 'wifi', label: 'WiFi' };
  if (/^(usb|rndis|enx)/i.test(name)) return { kind: 'usb', label: name };
  return { kind: 'ethernet', label: name };
}

function getLocalIps() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        ips.push({ name, address: addr.address });
      }
    }
  }
  return ips;
}

// --- startup ---

// The command a desktop shortcut should run: when running from the npx cache
// (which may be pruned) fall back to npx, otherwise pin the local install.
function relaunchCommand() {
  if (__dirname.includes('_npx')) return 'npx -y castview';
  return `"${process.execPath}" "${path.join(__dirname, 'server.js')}"`;
}

// Creates a proper launcher with the Castview icon that starts the server in
// the background — no terminal window. Stopping is done from the setup page.
function createDesktopShortcut() {
  const desktop = path.join(os.homedir(), 'Desktop');
  if (!fs.existsSync(desktop)) throw new Error('Desktop folder not found');
  const cmd = relaunchCommand();

  if (process.platform === 'darwin') {
    // A minimal .app bundle: gets a real icon and launches without Terminal.
    const app = path.join(desktop, 'Castview.app');
    fs.mkdirSync(path.join(app, 'Contents', 'MacOS'), { recursive: true });
    fs.mkdirSync(path.join(app, 'Contents', 'Resources'), { recursive: true });
    fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Castview</string>
  <key>CFBundleIdentifier</key><string>com.castview.launcher</string>
  <key>CFBundleExecutable</key><string>launcher</string>
  <key>CFBundleIconFile</key><string>castview</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
`);
    // GUI apps get a minimal PATH; add the common node locations for npx.
    fs.writeFileSync(path.join(app, 'Contents', 'MacOS', 'launcher'), `#!/bin/zsh
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
${cmd} &>/dev/null &
`, { mode: 0o755 });
    fs.copyFileSync(path.join(__dirname, 'assets', 'castview.icns'),
      path.join(app, 'Contents', 'Resources', 'castview.icns'));
    return app;
  }

  if (process.platform === 'win32') {
    // A .lnk with the Castview icon, launching node hidden via PowerShell.
    const lnk = path.join(desktop, 'Castview.lnk');
    const ico = path.join(__dirname, 'assets', 'castview.ico');
    const psTarget = cmd.replace(/'/g, "''");
    const script = [
      "$ws = New-Object -ComObject WScript.Shell;",
      `$s = $ws.CreateShortcut('${lnk.replace(/'/g, "''")}');`,
      "$s.TargetPath = 'powershell.exe';",
      `$s.Arguments = '-WindowStyle Hidden -Command "${psTarget}"';`,
      `$s.IconLocation = '${ico.replace(/'/g, "''")}';`,
      "$s.Description = 'Share this screen to any browser';",
      "$s.Save()",
    ].join(' ');
    execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { stdio: 'ignore' });
    return lnk;
  }

  const file = path.join(desktop, 'castview.desktop');
  fs.writeFileSync(file, [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Castview',
    'Comment=Share this screen to any browser',
    `Exec=${cmd}`,
    `Icon=${path.join(__dirname, 'assets', 'castview.png')}`,
    'Terminal=false',
    '',
  ].join('\n'), { mode: 0o755 });
  return file;
}

// Open the host setup page in the default browser (best effort; NO_OPEN=1 disables).
function openHostPage(url) {
  if (process.env.NO_OPEN) return;
  const cmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
    : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(cmd, args, () => {});
}

// Kill the ffmpeg child when the server dies, so it isn't orphaned.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopCapture();
    process.exit(0);
  });
}

// Launched again while already running (e.g. desktop shortcut double-click):
// don't crash silently, just show the existing session's setup page.
// The ws library re-emits http server errors on wss, so handle it there too.
function onListenError(err) {
  if (err.code === 'EADDRINUSE') {
    console.log(`Castview is already running on port ${PORT} — opening its setup page.`);
    openHostPage(`http://localhost:${PORT}/host`);
    process.exit(0);
  }
  throw err;
}
server.on('error', onListenError);
wss.on('error', () => {});

server.listen(PORT, async () => {
  console.log('Castview server running');
  console.log(`Port: ${PORT}`);
  if (PIN) console.log(`Access PIN: ${PIN} (QR codes include it; set PIN=off to disable)`);
  const ips = getLocalIps();
  if (ips.length === 0) {
    console.log('No non-internal IPv4 interfaces found. Check your network connection.');
    return;
  }
  console.log('Open one of these on your tablet/phone browser:');
  for (const { name, address } of ips) {
    console.log(`  http://${address}:${PORT}   (${name})`);
  }
  console.log(`Setup page with QR codes (open on this computer): http://localhost:${PORT}/host`);
  const url = `http://${ips[0].address}:${PORT}${PIN ? `/?pin=${PIN}` : ''}`;
  console.log(`\nScan to view (${url}):`);
  console.log(await QRCode.toString(url, { type: 'terminal', small: true }));
  openHostPage(`http://localhost:${PORT}/host`);
});
