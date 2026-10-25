console.log("OFFSCREEN JS LOADED");

// Signal to background.js that we're ready to receive messages
chrome.runtime.sendMessage({ type: "OFFSCREEN_READY" });

let audioCtx = null;
let mediaStream = null;
let workletNode = null;
let ws = null;
let reconnectTimer = null;
let currentStreamId = null;

const SERVER_WS = "ws://localhost:8787";
const RECONNECT_DELAY_MS = 2000;

let audioBuffer = [];
let sampleCount = 0;

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "OFFSCREEN_START") {
    startCapture(msg.streamId).catch(err => {
      console.error("startCapture failed:", err);
    });
  }

  if (msg.type === "OFFSCREEN_STOP") {
    stopAll().catch(err => {
      console.error("stopAll failed:", err);
    });
  }
});

function connectWebSocket() {
  if (ws && ws.readyState === WebSocket.OPEN) return;

  ws = new WebSocket(SERVER_WS);

  ws.onopen = () => {
    console.log("WS connected to server");
    clearReconnectTimer();
  };

  ws.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "LIVE" || msg.type === "FINAL") {
        chrome.runtime.sendMessage(msg);
      }
    } catch (e) {
      console.error("WS parse error", e);
    }
  };

  ws.onerror = (err) => console.error("WS error", err);

  ws.onclose = () => {
    console.log("WS closed");
    ws = null;
    // Reconnect if we still have an active capture
    if (audioCtx && currentStreamId) {
      scheduleReconnect();
    }
  };
}

function scheduleReconnect() {
  clearReconnectTimer();
  reconnectTimer = setTimeout(() => {
    console.log("Attempting WS reconnect...");
    connectWebSocket();
  }, RECONNECT_DELAY_MS);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

async function startCapture(streamId) {
  console.log("startCapture called with streamId:", streamId);

  await stopAll();

  audioBuffer = [];
  sampleCount = 0;
  currentStreamId = streamId;

  // Capture audio first — if this fails, we don't open a WebSocket
  console.log("Requesting getUserMedia...");
  mediaStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    }
  });
  console.log("getUserMedia succeeded");

  audioCtx = new AudioContext({ sampleRate: 24000 });
  await audioCtx.resume();
  console.log("AudioContext created, sampleRate:", audioCtx.sampleRate);

  await audioCtx.audioWorklet.addModule(chrome.runtime.getURL("pcm-worklet.js"));
  console.log("AudioWorklet module loaded");

  const source = audioCtx.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioCtx, "pcm16-processor");

  const SAMPLE_RATE = audioCtx.sampleRate;
  const MIN_SAMPLES = SAMPLE_RATE / 5; // 200ms chunks

  workletNode.port.onmessage = (evt) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    const pcm = new Int16Array(evt.data);
    audioBuffer.push(pcm);
    sampleCount += pcm.length;

    if (sampleCount >= MIN_SAMPLES) {
      sendAudio();
      sampleCount = 0;
    }
  };

  source.connect(workletNode);
  workletNode.connect(audioCtx.destination);

  // Now that audio capture is confirmed working, connect WebSocket
  connectWebSocket();

  console.log("Capture started — streaming to server");
}

function sendAudio() {
  if (audioBuffer.length === 0) return;

  const total = audioBuffer.reduce((s, b) => s + b.length, 0);
  const combined = new Int16Array(total);

  let offset = 0;
  for (const b of audioBuffer) {
    combined.set(b, offset);
    offset += b.length;
  }

  audioBuffer = [];

  const base64 = arrayBufferToBase64(combined.buffer);

  ws.send(JSON.stringify({
    type: "AUDIO",
    audioBase64: base64
  }));
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function stopAll() {
  clearReconnectTimer();
  currentStreamId = null;

  if (ws) {
    ws.close();
    ws = null;
  }
  if (audioCtx) {
    await audioCtx.close().catch(() => {});
    audioCtx = null;
  }
  if (mediaStream) {
    mediaStream.getTracks().forEach(t => t.stop());
    mediaStream = null;
  }
  workletNode = null;
  audioBuffer = [];
  sampleCount = 0;
}
