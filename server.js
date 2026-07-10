const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync, spawn } = require('child_process');
const WebSocket = require('ws');
const screenshot = require('screenshot-desktop');

const PORT = Number(process.env.PORT) || 8080;
const FPS = Number(process.env.FPS) || 15;
const MAX_WIDTH = Number(process.env.MAX_WIDTH) || 1600;
const JPEG_QUALITY = Number(process.env.JPEG_QUALITY) || 7; // ffmpeg -q:v scale, 2 (best) to 31 (worst)

const viewerHtml = fs.readFileSync(path.join(__dirname, 'viewer.html'));

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(viewerHtml);
    return;
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

const wss = new WebSocket.Server({ server });

function broadcast(frame) {
  for (const client of wss.clients) {
    // Skip clients that haven't drained the previous frame yet, so a slow
    // viewer lags instead of building up a growing backlog of stale frames.
    if (client.readyState === WebSocket.OPEN && client.bufferedAmount === 0) {
      client.send(frame, { binary: true });
    }
  }
}

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
    return ['-f', 'avfoundation', '-capture_cursor', '1', '-pixel_format', 'uyvy422', '-framerate', String(FPS), '-i', 'Capture screen 0'];
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
  const args = [
    '-loglevel', 'error',
    ...ffmpegInputArgs(),
    '-vf', `scale='min(${MAX_WIDTH},iw)':-2`,
    // avfoundation's screen device reports a bogus huge timebase; without an
    // explicit output rate ffmpeg duplicates frames as fast as CPU allows.
    '-r', String(FPS),
    '-q:v', String(JPEG_QUALITY),
    '-f', 'mjpeg',
    'pipe:1',
  ];
  ffmpegProc = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });

  // Extract complete JPEGs from the MJPEG byte stream (SOI ffd8 .. EOI ffd9).
  let buf = Buffer.alloc(0);
  ffmpegProc.stdout.on('data', (chunk) => {
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

  ffmpegProc.stderr.on('data', (d) => console.error('ffmpeg:', d.toString().trim()));

  ffmpegProc.on('exit', (code, signal) => {
    ffmpegProc = null;
    // Only restart on unexpected death, not when we killed it ourselves.
    if (signal !== 'SIGTERM' && wss.clients.size > 0) {
      console.error(`ffmpeg exited (code ${code}), restarting in 1s`);
      ffmpegRestartTimer = setTimeout(() => {
        ffmpegRestartTimer = null;
        if (wss.clients.size > 0) startCapture();
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
  ffmpegProc.kill('SIGTERM');
  ffmpegProc = null;
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
  return screenshot({ format: 'jpg' });
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

wss.on('connection', (ws) => {
  console.log('Viewer connected');
  startCapture();

  ws.on('close', () => {
    console.log('Viewer disconnected');
    if (wss.clients.size === 0) stopCapture();
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

// Kill the ffmpeg child when the server dies, so it isn't orphaned.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopCapture();
    process.exit(0);
  });
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

server.listen(PORT, () => {
  console.log('Castview server running');
  console.log(`Port: ${PORT}`);
  const ips = getLocalIps();
  if (ips.length === 0) {
    console.log('No non-internal IPv4 interfaces found. Check your network connection.');
  } else {
    console.log('Open one of these on your tablet/phone browser:');
    for (const { name, address } of ips) {
      console.log(`  http://${address}:${PORT}   (${name})`);
    }
  }
});
