'use strict';

// ─── Constants ────────────────────────────────────────────────────────────────
const DOWNLOAD_DURATION_MS   = 10000;
const UPLOAD_DURATION_MS     = 10000;
const PING_COUNT             = 12;
const CONNECT_TIMEOUT_MS     = 8000;
const WS_FRAME_SIZE          = 64 * 1024;        // 64 KB per WebSocket frame
const WS_UPLOAD_BUFFER_HIGH  = WS_FRAME_SIZE * 4; // pause sending if buffer exceeds this

const ARC_LENGTH    = 482.52;
const ARC_SWEEP_DEG = 240;
const CX = 150, CY = 165, R = 115;
const START_DEG = 150;

// ─── State ────────────────────────────────────────────────────────────────────
let threads    = 1;
let currentMax = 100;
let isRunning  = false;
let results    = {};

// ─── Helpers ──────────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));
const $     = id  => document.getElementById(id);

/** Convert http(s):// agent URL → ws(s):// */
function toWsUrl(httpUrl, path) {
  return httpUrl.replace(/^http/, 'ws') + path;
}

// ─── DOM refs ─────────────────────────────────────────────────────────────────
const speedArc         = $('speed-arc');
const speedValue       = $('speed-value');
const speedUnit        = $('speed-unit');
const phaseLabel       = $('phase-label');
const startBtn         = $('start-btn');
const btnText          = $('btn-text');
const agentSelect      = $('agent-select');
const scaleMax         = $('scale-max');
const livePing         = $('live-ping');
const liveDownload     = $('live-download');
const liveUpload       = $('live-upload');
const resultsCard      = $('results-card');
const threadStatus     = $('thread-status');
const threadDotsEl     = $('thread-dots');
const threadCountLabel = $('thread-count-label');

// ─── Agent config ─────────────────────────────────────────────────────────────
function loadAgents() {
  const agents = (typeof window.SPEEDTEST_AGENTS !== 'undefined' && window.SPEEDTEST_AGENTS.length)
    ? window.SPEEDTEST_AGENTS.filter(a => a.url)
    : [{ name: 'Local Agent', url: 'http://localhost:8081' }];

  agentSelect.innerHTML = '';
  agents.forEach(a => {
    const opt = document.createElement('option');
    opt.value = a.url;
    opt.textContent = a.name || a.url;
    agentSelect.appendChild(opt);
  });
}

// ─── Thread dot UI ────────────────────────────────────────────────────────────
let dotStates = [];

function initDots(count) {
  threadDotsEl.innerHTML = '';
  dotStates = Array(count).fill('idle');
  for (let i = 0; i < count; i++) {
    const d = document.createElement('div');
    d.className = 'thread-dot';
    d.id = `dot-${i}`;
    threadDotsEl.appendChild(d);
  }
  threadStatus.style.visibility = 'visible';
  updateThreadLabel();
}

function setDot(i, state) {
  dotStates[i] = state;
  const el = $(`dot-${i}`);
  if (!el) return;
  el.className = 'thread-dot' + (state !== 'idle' ? ` ${state}` : '');
  updateThreadLabel();
}

function updateThreadLabel() {
  const active      = dotStates.filter(s => s.startsWith('active')).length;
  const connecting  = dotStates.filter(s => s === 'connecting').length;
  const total       = dotStates.length;
  if (active === 0 && connecting > 0) {
    threadCountLabel.textContent = `Connecting… ${connecting} / ${total}`;
  } else if (active > 0) {
    threadCountLabel.textContent = `${active} / ${total} threads active`;
  } else {
    threadCountLabel.textContent = `${total} thread${total !== 1 ? 's' : ''}`;
  }
}

function hideThreadStatus() {
  threadStatus.style.visibility = 'hidden';
}

// ─── Speedometer ─────────────────────────────────────────────────────────────
function svgPoint(angleDeg, radius) {
  const rad = (angleDeg * Math.PI) / 180;
  return { x: CX + radius * Math.cos(rad), y: CY + radius * Math.sin(rad) };
}

function drawTicks() {
  const ticksEl = $('ticks');
  ticksEl.innerHTML = '';
  for (let i = 0; i <= 24; i++) {
    const angleDeg = START_DEG + i * (ARC_SWEEP_DEG / 24);
    const major    = i % 4 === 0;
    const inner    = svgPoint(angleDeg, R - (major ? 18 : 10));
    const outer    = svgPoint(angleDeg, R);
    const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    line.setAttribute('x1', inner.x.toFixed(2)); line.setAttribute('y1', inner.y.toFixed(2));
    line.setAttribute('x2', outer.x.toFixed(2)); line.setAttribute('y2', outer.y.toFixed(2));
    line.setAttribute('class', major ? 'tick-major' : 'tick-minor');
    ticksEl.appendChild(line);
    if (major) {
      const labelPt = svgPoint(angleDeg, R - 28);
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
      text.setAttribute('x', labelPt.x.toFixed(2));
      text.setAttribute('y', labelPt.y.toFixed(2));
      text.setAttribute('text-anchor', 'middle');
      text.setAttribute('dominant-baseline', 'middle');
      text.setAttribute('class', 'tick-label');
      const val = Math.round(currentMax * (i / 24));
      text.textContent = val >= 1000 ? `${(val / 1000).toFixed(0)}G` : val;
      ticksEl.appendChild(text);
    }
  }
}

function setArcFraction(fraction, mode) {
  const offset = ARC_LENGTH * (1 - Math.max(0, Math.min(1, fraction)));
  speedArc.style.strokeDashoffset = offset.toFixed(2);
  if (mode === 'upload') {
    speedArc.setAttribute('stroke', 'url(#arc-grad-upload)');
    speedArc.setAttribute('filter', 'url(#glow-purple)');
  } else {
    speedArc.setAttribute('stroke', 'url(#arc-grad-download)');
    speedArc.setAttribute('filter', 'url(#glow-cyan)');
  }
}

function updateSpeedometer(mbps, mode) {
  if (mbps > currentMax * 0.75) {
    currentMax = Math.pow(2, Math.ceil(Math.log2(mbps * 1.5)));
    scaleMax.textContent = currentMax >= 1000 ? `${currentMax / 1000}Gbps` : currentMax;
    drawTicks();
  }
  setArcFraction(mbps / currentMax, mode);
  if (mbps >= 1000) {
    speedValue.textContent = (mbps / 1000).toFixed(2);
    speedUnit.textContent  = 'Gbps';
  } else {
    speedValue.textContent = mbps >= 100 ? mbps.toFixed(1) : mbps.toFixed(2);
    speedUnit.textContent  = 'Mbps';
  }
}

function resetSpeedometer() {
  currentMax = 100;
  scaleMax.textContent = '100';
  drawTicks();
  setArcFraction(0, 'download');
  speedValue.textContent = '0.00';
  speedUnit.textContent  = 'Mbps';
  phaseLabel.textContent = 'Ready';
}

// ─── Phase UI ─────────────────────────────────────────────────────────────────
function setPhase(name) {
  const order = ['ping', 'download', 'upload'];
  const idx   = order.indexOf(name);
  order.forEach((p, i) => {
    const el = $(`step-${p}`);
    el.classList.remove('active', 'done');
    if (i < idx)        el.classList.add('done');
    else if (i === idx) el.classList.add('active');
  });
  document.querySelectorAll('.phase-line').forEach((line, i) => {
    line.classList.toggle('done', i < idx);
  });
  const labels = { ping: 'PING', download: 'DOWNLOAD', upload: 'UPLOAD' };
  phaseLabel.textContent = labels[name] || '';
}

function allPhaseDone() {
  ['ping', 'download', 'upload'].forEach(p => {
    $(`step-${p}`).classList.remove('active');
    $(`step-${p}`).classList.add('done');
  });
  document.querySelectorAll('.phase-line').forEach(l => l.classList.add('done'));
  phaseLabel.textContent = 'COMPLETE';
}

// ─── Mode ─────────────────────────────────────────────────────────────────────
const USE_WEBSOCKET = (window.SPEEDTEST_MODE || 'websocket') !== 'http';

// ─── Ping test (HTTP — no buffering concern here) ─────────────────────────────
async function runPing(agentUrl) {
  const latencies = [];
  for (let i = 0; i < PING_COUNT; i++) {
    const t0 = performance.now();
    try { await fetch(`${agentUrl}/ping`, { cache: 'no-store' }); } catch { continue; }
    latencies.push(performance.now() - t0);
  }
  if (!latencies.length) throw new Error('Ping failed — agent not reachable');
  const avg    = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const jitter = latencies.reduce((acc, v, i, arr) =>
    i === 0 ? 0 : acc + Math.abs(v - arr[i - 1]), 0) / Math.max(latencies.length - 1, 1);
  return { ping: avg, jitter };
}

// ─── WebSocket: Download ──────────────────────────────────────────────────────
// N connections receive binary frames from the server; we count bytes as they arrive.
async function runDownload(agentUrl, threadCount) {
  const wsUrl = toWsUrl(agentUrl, '/ws/download');
  let totalBytes   = 0;
  let measureStart = null;
  let running      = true;

  initDots(threadCount);

  const doThread = async (idx) => {
    while (running) {
      setDot(idx, 'connecting');

      await new Promise((resolve) => {
        let ws;
        try { ws = new WebSocket(wsUrl); }
        catch { resolve(); return; }
        ws.binaryType = 'arraybuffer';

        // Close the socket when the test ends
        const stopWatcher = setInterval(() => {
          if (!running && ws.readyState === WebSocket.OPEN) {
            ws.close(1000, 'test complete');
            clearInterval(stopWatcher);
          }
        }, 50);

        ws.onopen = () => {
          setDot(idx, 'active-download');
          if (!measureStart) measureStart = performance.now();
        };

        ws.onmessage = (e) => {
          if (e.data instanceof ArrayBuffer) totalBytes += e.data.byteLength;
        };

        ws.onerror = () => { clearInterval(stopWatcher); resolve(); };

        ws.onclose = () => {
          clearInterval(stopWatcher);
          setDot(idx, 'idle');
          resolve();
        };
      });

      if (!running) break;
      await sleep(200); // brief pause before reconnecting if the server closed the socket
    }
    setDot(idx, 'idle');
  };

  for (let i = 0; i < threadCount; i++) doThread(i);

  // Wait for first connection or give up
  const deadline = performance.now() + CONNECT_TIMEOUT_MS + 1000;
  while (!measureStart && performance.now() < deadline) await sleep(100);
  if (!measureStart) throw new Error('WebSocket download connections timed out — is the agent running?');

  const interval = setInterval(() => {
    const elapsed = (performance.now() - measureStart) / 1000;
    if (elapsed > 0.1) {
      const mbps = (totalBytes * 8) / (elapsed * 1e6);
      updateSpeedometer(mbps, 'download');
      liveDownload.textContent = mbps.toFixed(1);
    }
  }, 200);

  await sleep(DOWNLOAD_DURATION_MS);
  running = false;
  clearInterval(interval);

  const finalSec = (performance.now() - measureStart) / 1000;
  return (totalBytes * 8) / (finalSec * 1e6);
}

// ─── WebSocket: Upload ────────────────────────────────────────────────────────
// N connections send binary frames; server ACKs each frame with {"received":N}.
// We measure throughput from ACKs — what the origin server actually received —
// so results are accurate even behind a proxy that buffers HTTP uploads.
async function runUpload(agentUrl, threadCount) {
  const wsUrl = toWsUrl(agentUrl, '/ws/upload');

  // Pre-fill an ArrayBuffer with non-zero bytes (some proxies may skip zero payloads)
  const frameBuffer = new ArrayBuffer(WS_FRAME_SIZE);
  new Uint8Array(frameBuffer).fill(0xAB);

  // Per-thread server-acknowledged byte counts
  const serverReceived = new Array(threadCount).fill(0);
  let measureStart = null;
  let running      = true;

  initDots(threadCount);

  const doThread = async (idx) => {
    while (running) {
      setDot(idx, 'connecting');
      serverReceived[idx] = 0;

      await new Promise((resolve) => {
        let ws;
        try { ws = new WebSocket(wsUrl); }
        catch { resolve(); return; }
        ws.binaryType = 'arraybuffer';

        const stopWatcher = setInterval(() => {
          if (!running && ws.readyState === WebSocket.OPEN) {
            ws.close(1000, 'test complete');
            clearInterval(stopWatcher);
          }
        }, 50);

        ws.onopen = () => {
          setDot(idx, 'active-upload');
          if (!measureStart) measureStart = performance.now();

          // Send frames as fast as the socket buffer allows
          const sendLoop = () => {
            if (!running || ws.readyState !== WebSocket.OPEN) return;
            if (ws.bufferedAmount > WS_UPLOAD_BUFFER_HIGH) {
              // Back off briefly to avoid over-filling the browser send buffer,
              // which would inflate the apparent throughput above actual link speed
              setTimeout(sendLoop, 5);
              return;
            }
            ws.send(frameBuffer);
            setTimeout(sendLoop, 0);
          };
          sendLoop();
        };

        ws.onmessage = (e) => {
          // ACK from server: {"received": N}
          try {
            const ack = JSON.parse(e.data);
            if (typeof ack.received === 'number') serverReceived[idx] = ack.received;
          } catch { /* ignore malformed frames */ }
        };

        ws.onerror = () => { clearInterval(stopWatcher); resolve(); };

        ws.onclose = () => {
          clearInterval(stopWatcher);
          setDot(idx, 'idle');
          resolve();
        };
      });

      if (!running) break;
      await sleep(200);
    }
    setDot(idx, 'idle');
  };

  for (let i = 0; i < threadCount; i++) doThread(i);

  // Wait for first connection or give up
  const deadline = performance.now() + CONNECT_TIMEOUT_MS + 1000;
  while (!measureStart && performance.now() < deadline) await sleep(100);
  if (!measureStart) throw new Error('WebSocket upload connections timed out — is the agent running?');

  const interval = setInterval(() => {
    const elapsed = (performance.now() - measureStart) / 1000;
    if (elapsed > 0.1) {
      const totalAcked = serverReceived.reduce((a, b) => a + b, 0);
      const mbps = (totalAcked * 8) / (elapsed * 1e6);
      updateSpeedometer(mbps, 'upload');
      liveUpload.textContent = mbps.toFixed(1);
    }
  }, 200);

  await sleep(UPLOAD_DURATION_MS);
  running = false;
  clearInterval(interval);

  const finalSec    = (performance.now() - measureStart) / 1000;
  const totalAcked  = serverReceived.reduce((a, b) => a + b, 0);
  return (totalAcked * 8) / (finalSec * 1e6);
}

// ─── HTTP fallback: Download ──────────────────────────────────────────────────
async function runDownloadHTTP(agentUrl, threadCount) {
  const BYTES = 25 * 1024 * 1024;
  let totalBytes   = 0;
  let running      = true;
  let measureStart = null;

  initDots(threadCount);

  const doThread = async (idx) => {
    while (running) {
      setDot(idx, 'connecting');
      const controller = new AbortController();
      const connectTimer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
      let resp;
      try {
        resp = await fetch(`${agentUrl}/download?bytes=${BYTES}`, { cache: 'no-store', signal: controller.signal });
        clearTimeout(connectTimer);
      } catch {
        clearTimeout(connectTimer);
        setDot(idx, 'idle');
        if (!running) return;
        await sleep(500);
        continue;
      }
      setDot(idx, 'active-download');
      if (!measureStart) measureStart = performance.now();
      const reader = resp.body.getReader();
      try {
        while (running) {
          const { done, value } = await reader.read();
          if (done) break;
          totalBytes += value.byteLength;
        }
      } catch { /* interrupted */ }
    }
    setDot(idx, 'idle');
  };

  for (let i = 0; i < threadCount; i++) doThread(i);

  const deadline = performance.now() + CONNECT_TIMEOUT_MS + 1000;
  while (!measureStart && performance.now() < deadline) await sleep(100);
  if (!measureStart) throw new Error('HTTP download threads could not connect to the agent.');

  const interval = setInterval(() => {
    const elapsed = (performance.now() - measureStart) / 1000;
    if (elapsed > 0.1) {
      const mbps = (totalBytes * 8) / (elapsed * 1e6);
      updateSpeedometer(mbps, 'download');
      liveDownload.textContent = mbps.toFixed(1);
    }
  }, 200);

  await sleep(DOWNLOAD_DURATION_MS);
  running = false;
  clearInterval(interval);
  return (totalBytes * 8) / ((performance.now() - measureStart) / 1000 / 1e6);
}

// ─── HTTP fallback: Upload ────────────────────────────────────────────────────
async function runUploadHTTP(agentUrl, threadCount) {
  const BLOB_SIZE = 25 * 1024 * 1024;
  const blob = new Blob([new Uint8Array(BLOB_SIZE)]);
  let uploadedBytes = 0;
  let running       = true;
  let measureStart  = null;

  initDots(threadCount);

  const doThread = async (idx) => {
    while (running) {
      setDot(idx, 'active-upload');
      if (!measureStart) measureStart = performance.now();
      const controller = new AbortController();
      const reqTimer = setTimeout(() => controller.abort(), 20000);
      try {
        const resp = await fetch(`${agentUrl}/upload?_=${Date.now()}`, {
          method: 'POST', body: blob,
          headers: { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store, no-cache', 'Pragma': 'no-cache' },
          cache: 'no-store', signal: controller.signal,
        });
        clearTimeout(reqTimer);
        if (resp.ok) uploadedBytes += BLOB_SIZE;
      } catch {
        clearTimeout(reqTimer);
        if (!running) { setDot(idx, 'idle'); return; }
        await sleep(200);
      }
    }
    setDot(idx, 'idle');
  };

  for (let i = 0; i < threadCount; i++) doThread(i);

  const deadline = performance.now() + CONNECT_TIMEOUT_MS + 1000;
  while (!measureStart && performance.now() < deadline) await sleep(100);
  if (!measureStart) throw new Error('HTTP upload threads could not reach the agent.');

  const interval = setInterval(() => {
    const elapsed = (performance.now() - measureStart) / 1000;
    if (elapsed > 0.1) {
      const mbps = (uploadedBytes * 8) / (elapsed * 1e6);
      updateSpeedometer(mbps, 'upload');
      liveUpload.textContent = mbps.toFixed(1);
    }
  }, 200);

  await sleep(UPLOAD_DURATION_MS);
  running = false;
  clearInterval(interval);
  return (uploadedBytes * 8) / ((performance.now() - measureStart) / 1000 / 1e6);
}

// ─── Results ──────────────────────────────────────────────────────────────────
function formatSpeed(mbps) {
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(2)} Gbps`;
  return mbps >= 100 ? `${mbps.toFixed(1)}` : `${mbps.toFixed(2)}`;
}

function showResults(r) {
  $('result-ping').textContent     = `${r.ping.toFixed(1)} ms`;
  $('result-jitter').textContent   = `±${r.jitter.toFixed(1)} ms jitter`;
  $('result-download').textContent = formatSpeed(r.download);
  $('result-upload').textContent   = formatSpeed(r.upload);
  $('result-server').textContent   = r.serverName;
  $('result-threads').textContent  = `${r.threads} thread${r.threads !== 1 ? 's' : ''}`;
  $('result-time').textContent     = new Date().toLocaleString();
  resultsCard.style.display = 'block';
  resultsCard.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// ─── Copy results ─────────────────────────────────────────────────────────────
$('copy-btn').addEventListener('click', () => {
  const r    = results;
  const text =
`AlienX SpeedTest Results
━━━━━━━━━━━━━━━━━━━━━━━━━
Ping:     ${r.ping.toFixed(1)} ms (±${r.jitter.toFixed(1)} ms jitter)
Download: ${formatSpeed(r.download)} Mbps
Upload:   ${formatSpeed(r.upload)} Mbps
Server:   ${r.serverName}
Threads:  ${r.threads}
Date:     ${new Date().toLocaleString()}
━━━━━━━━━━━━━━━━━━━━━━━━━
Tested with AlienX SpeedTest — https://github.com/AlienXAXS/AlienX-SpeedTest`;

  navigator.clipboard.writeText(text).then(() => {
    const btn = $('copy-btn');
    btn.textContent = '✓ Copied!';
    setTimeout(() => {
      btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" width="16" height="16"><rect x="9" y="9" width="13" height="13" rx="2" stroke="currentColor" stroke-width="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" stroke="currentColor" stroke-width="2"/></svg> Copy Results`;
    }, 2000);
  });
});

// ─── Retest ───────────────────────────────────────────────────────────────────
$('retest-btn').addEventListener('click', () => {
  resultsCard.style.display = 'none';
  resetSpeedometer();
  hideThreadStatus();
  livePing.textContent = liveDownload.textContent = liveUpload.textContent = '--';
  ['ping', 'download', 'upload'].forEach(p => $(`step-${p}`).classList.remove('active', 'done'));
  document.querySelectorAll('.phase-line').forEach(l => l.classList.remove('done'));
});

// ─── Thread button clicks ─────────────────────────────────────────────────────
document.querySelectorAll('.thread-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (isRunning) return;
    document.querySelectorAll('.thread-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    threads = parseInt(btn.dataset.threads, 10);
  });
});

// ─── Main test runner ─────────────────────────────────────────────────────────
startBtn.addEventListener('click', async () => {
  if (isRunning) return;

  const agentUrl   = agentSelect.value;
  if (!agentUrl || agentUrl === 'loading') return;
  const serverName = agentSelect.options[agentSelect.selectedIndex].textContent;

  isRunning = true;
  resultsCard.style.display = 'none';
  resetSpeedometer();
  startBtn.disabled = true;
  startBtn.classList.add('running');
  btnText.textContent = 'Running…';
  document.querySelectorAll('.thread-btn, .control-select').forEach(el => el.disabled = true);
  livePing.textContent = liveDownload.textContent = liveUpload.textContent = '--';

  try {
    // ── Ping (HTTP) ───────────────────────────────────────────────────────────
    setPhase('ping');
    const pingResult = await runPing(agentUrl);
    livePing.textContent = pingResult.ping.toFixed(1);

    // ── Download ──────────────────────────────────────────────────────────────
    setArcFraction(0, 'download');
    speedValue.textContent = '0.00';
    setPhase('download');
    const downloadMbps = USE_WEBSOCKET
      ? await runDownload(agentUrl, threads)
      : await runDownloadHTTP(agentUrl, threads);
    liveDownload.textContent = downloadMbps.toFixed(1);

    // ── Upload ────────────────────────────────────────────────────────────────
    currentMax = 100;
    scaleMax.textContent = '100';
    drawTicks();
    setArcFraction(0, 'upload');
    speedValue.textContent = '0.00';
    setPhase('upload');
    const uploadMbps = USE_WEBSOCKET
      ? await runUpload(agentUrl, threads)
      : await runUploadHTTP(agentUrl, threads);
    liveUpload.textContent = uploadMbps.toFixed(1);

    // ── Done ──────────────────────────────────────────────────────────────────
    allPhaseDone();
    updateSpeedometer(downloadMbps, 'download');
    hideThreadStatus();

    results = { ping: pingResult.ping, jitter: pingResult.jitter, download: downloadMbps, upload: uploadMbps, serverName, threads };
    showResults(results);

  } catch (err) {
    phaseLabel.textContent = 'ERROR';
    speedValue.textContent = '!';
    hideThreadStatus();
    console.error('SpeedTest error:', err);
    alert(`Test failed: ${err.message}\n\nMake sure the agent is running and reachable.`);
  } finally {
    isRunning = false;
    startBtn.disabled = false;
    startBtn.classList.remove('running');
    btnText.textContent = 'Start Test';
    document.querySelectorAll('.thread-btn, .control-select').forEach(el => el.disabled = false);
  }
});

// ─── Init ─────────────────────────────────────────────────────────────────────
loadAgents();
drawTicks();
