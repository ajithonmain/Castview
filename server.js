const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WebSocket = require('ws');
const screenshot = require('screenshot-desktop');

const PORT = Number(process.env.PORT) || 8080;
const FPS = Number(process.env.FPS) || 10;

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

let captureTimer = null;
let capturing = false;

function startCaptureLoop() {
  if (captureTimer) return;
  captureTimer = setInterval(captureAndBroadcast, 1000 / FPS);
}

function stopCaptureLoop() {
  if (!captureTimer) return;
  clearInterval(captureTimer);
  captureTimer = null;
}

async function captureAndBroadcast() {
  if (wss.clients.size === 0) {
    stopCaptureLoop();
    return;
  }
  if (capturing) return;
  capturing = true;
  try {
    const img = await screenshot({ format: 'jpg' });
    for (const client of wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(img, { binary: true });
      }
    }
  } catch (err) {
    console.error('Capture failed:', err.message);
    if (process.platform === 'darwin') {
      console.error('If this persists, grant Screen Recording permission: System Settings > Privacy & Security > Screen Recording');
    }
  } finally {
    capturing = false;
  }
}

wss.on('connection', (ws) => {
  console.log('Viewer connected');
  startCaptureLoop();

  ws.on('close', () => {
    console.log('Viewer disconnected');
    if (wss.clients.size === 0) {
      stopCaptureLoop();
    }
  });

  ws.on('error', (err) => {
    console.error('WebSocket error:', err.message);
  });
});

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
