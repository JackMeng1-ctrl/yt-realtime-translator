// server.js — Realtime transcription + translation relay
//
// Extension (PCM16 audio over WS) -> this server -> OpenAI Realtime (transcription session)
//   -> translate each finished segment -> send LIVE / FINAL subtitles back to the extension

import "dotenv/config";
import WebSocket, { WebSocketServer } from "ws";
import { translateWithLLM } from "./translate.js";

const PORT = Number(process.env.PORT || 8787);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const TRANSCRIBE_MODEL = process.env.TRANSCRIBE_MODEL || "gpt-live-transcribe";
const TRANSLATE_MODEL = process.env.TRANSLATE_MODEL || "gpt-4o";
const TARGET_LANG = process.env.TARGET_LANG || "简体中文";

// A transcription-only session must be opened with ?intent=transcription.
// A ?model=... URL creates a *conversation* session, which rejects the
// transcription session.update below — that was the original bug.
const OPENAI_REALTIME_URL = "wss://api.openai.com/v1/realtime?intent=transcription";

// --- Turn segmentation (client-side VAD) ---
// gpt-live-transcribe has no server-side turn detection: the client must send
// input_audio_buffer.commit at the end of each turn to get a final transcript.
// We detect turns from the audio level of the PCM16 chunks the extension sends.
const SAMPLE_RATE = 24000;
const VAD_RMS_THRESHOLD = Number(process.env.VAD_RMS_THRESHOLD || 500); // int16 RMS above this = speech
const MIN_SPEECH_MS = 300;    // need at least this much speech before committing
const END_SILENCE_MS = 600;   // this much trailing silence ends a turn
const MAX_SEGMENT_MS = Number(process.env.MAX_SEGMENT_MS || 7000); // force a commit for long continuous speech / BGM
const MAX_IDLE_BUFFER_MS = 10000; // clear buffers that never contained speech

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 30000;
const ORDER_WAIT_MS = 5000; // max time to hold later segments while an earlier one is missing

if (!OPENAI_API_KEY) {
  console.error("Missing OPENAI_API_KEY in .env");
  process.exit(1);
}

const SYSTEM_PROMPT =
  `你是视频字幕翻译。把用户发来的一句字幕翻译成流畅自然的${TARGET_LANG}。` +
  `如果原文已经是${TARGET_LANG}，原样输出。只输出译文，不要添加任何解释。`;

const wss = new WebSocketServer({ port: PORT });
console.log(`Server listening on ws://localhost:${PORT}`);
console.log(`Transcribe model: ${TRANSCRIBE_MODEL} | Translate model: ${TRANSLATE_MODEL} | Target: ${TARGET_LANG}`);

wss.on("connection", (clientWs) => {
  console.log("Extension connected");

  let openaiWs = null;
  let reconnectTimer = null;
  let reconnectDelay = RECONNECT_MIN_MS;
  let clientAlive = true;
  const seenEventTypes = new Set();

  // Segmenter state (reset whenever a new OpenAI session starts)
  let segMs = 0;
  let speechMs = 0;
  let silenceMs = 0;
  const resetSegment = () => { segMs = 0; speechMs = 0; silenceMs = 0; };

  // Lightweight audio stats, logged every 10s — tells you at a glance whether audio is arriving
  let stats = { chunks: 0, bytes: 0, rmsSum: 0, commits: 0 };
  let warnedNoAudio = false;
  const statsTimer = setInterval(() => {
    if (stats.chunks === 0) {
      if (!warnedNoAudio) {
        console.log("[audio] nothing received in the last 10s — is the video playing?");
        warnedNoAudio = true;
      }
      return;
    }
    warnedNoAudio = false;
    console.log(
      `[audio] ${stats.chunks} chunks, ${(stats.bytes / 1024).toFixed(0)} KB, ` +
      `avg level ${Math.round(stats.rmsSum / stats.chunks)} (speech threshold ${VAD_RMS_THRESHOLD}), ` +
      `turns committed ${stats.commits}`
    );
    stats = { chunks: 0, bytes: 0, rmsSum: 0, commits: 0 };
  }, 10000);

  function onAudioChunk(buf) {
    const n = buf.length >> 1; // PCM16 little-endian samples
    if (n === 0) return;

    let sumSq = 0;
    for (let i = 0; i < n; i++) {
      const v = buf.readInt16LE(i * 2);
      sumSq += v * v;
    }
    const rms = Math.sqrt(sumSq / n);
    const ms = (n / SAMPLE_RATE) * 1000;

    stats.chunks++;
    stats.bytes += buf.length;
    stats.rmsSum += rms;

    segMs += ms;
    if (rms >= VAD_RMS_THRESHOLD) {
      speechMs += ms;
      silenceMs = 0;
    } else {
      silenceMs += ms;
    }

    const endOfTurn = speechMs >= MIN_SPEECH_MS && silenceMs >= END_SILENCE_MS;
    const tooLong = speechMs >= MIN_SPEECH_MS && segMs >= MAX_SEGMENT_MS;

    if (endOfTurn || tooLong) {
      openaiWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
      stats.commits++;
      resetSegment();
    } else if (speechMs < MIN_SPEECH_MS && segMs >= MAX_IDLE_BUFFER_MS) {
      openaiWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
      resetSegment();
    }
  }

  const sendToClient = (obj) => {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(obj));
  };

  // ---------------------------------------------------------------
  // Ordering: completed events for different speech segments can
  // arrive out of order, and translations finish at different speeds.
  // Each item_id gets a sequence number the first time we see it,
  // and FINAL lines are released strictly in that order.
  // ---------------------------------------------------------------
  let nextSeq = 0;
  let nextToEmit = 0;
  let orderTimer = null;
  const seqByItem = new Map();  // item_id -> seq
  const liveByItem = new Map(); // item_id -> partial transcript (insertion order = speech order)
  const ready = new Map();      // seq -> translated text ("" = nothing to show)

  const seqFor = (itemId) => {
    if (!seqByItem.has(itemId)) seqByItem.set(itemId, nextSeq++);
    return seqByItem.get(itemId);
  };

  function sendLatestLive() {
    let latest = "";
    for (const text of liveByItem.values()) latest = text; // last = most recent segment
    sendToClient({ type: "LIVE", text: latest });
  }

  function flushInOrder() {
    while (ready.has(nextToEmit)) {
      const text = ready.get(nextToEmit);
      ready.delete(nextToEmit);
      nextToEmit++;
      if (text) {
        sendToClient({ type: "FINAL", text });
        console.log("Final:", text.substring(0, 60));
      }
    }

    // A later segment is ready but an earlier one hasn't finished:
    // don't block forever — skip the gap after ORDER_WAIT_MS.
    clearTimeout(orderTimer);
    if (ready.size > 0) {
      orderTimer = setTimeout(() => {
        const earliest = Math.min(...ready.keys());
        if (earliest > nextToEmit) {
          console.warn(`Skipping segment(s) ${nextToEmit}..${earliest - 1}: no transcript arrived in time`);
          nextToEmit = earliest;
        }
        flushInOrder();
      }, ORDER_WAIT_MS);
    }
  }

  async function handleCompleted(itemId, transcript) {
    const seq = seqFor(itemId);
    seqByItem.delete(itemId);
    liveByItem.delete(itemId);
    sendLatestLive();

    if (seq < nextToEmit) {
      console.warn(`Dropping late segment ${seq} (already skipped)`);
      return;
    }

    const text = (transcript || "").trim();
    let translated = "";
    if (text) {
      try {
        translated = await translateWithLLM({
          apiKey: OPENAI_API_KEY,
          model: TRANSLATE_MODEL,
          text,
          systemPrompt: SYSTEM_PROMPT
        });
      } catch (err) {
        console.error("Translation error:", err.message);
        translated = text; // fall back to the original text rather than showing nothing
      }
    }

    ready.set(seq, translated);
    flushInOrder();
  }

  // ===============================
  // OpenAI Realtime connection
  // ===============================

  function connectOpenAI() {
    openaiWs = new WebSocket(OPENAI_REALTIME_URL, {
      headers: { Authorization: `Bearer ${OPENAI_API_KEY}` }
    });

    openaiWs.on("open", () => {
      console.log("OpenAI Realtime connected");
      reconnectDelay = RECONNECT_MIN_MS;
      resetSegment();

      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: { type: "audio/pcm", rate: 24000 },
              transcription: { model: TRANSCRIBE_MODEL },
              // gpt-live-transcribe doesn't support server_vad / semantic_vad,
              // so turns are committed by onAudioChunk() below
              turn_detection: null
            }
          }
        }
      }));
    });

    openaiWs.on("message", (raw) => {
      let evt;
      try {
        evt = JSON.parse(raw.toString());
      } catch {
        return;
      }

      switch (evt.type) {
        case "session.updated":
        case "transcription_session.updated":
          console.log("Transcription session configured");
          break;

        case "conversation.item.input_audio_transcription.delta": {
          const id = evt.item_id;
          seqFor(id);
          liveByItem.set(id, (liveByItem.get(id) || "") + (evt.delta || ""));
          sendLatestLive();
          break;
        }

        case "conversation.item.input_audio_transcription.completed":
          handleCompleted(evt.item_id, evt.transcript ?? liveByItem.get(evt.item_id));
          break;

        case "error":
          console.error("OpenAI error:", JSON.stringify(evt.error));
          break;

        default:
          // Log each unfamiliar event type once — handy when debugging
          if (!seenEventTypes.has(evt.type)) {
            seenEventTypes.add(evt.type);
            console.log("(event)", evt.type);
          }
      }
    });

    openaiWs.on("close", (code, reason) => {
      console.log(`OpenAI Realtime closed (code ${code}) ${reason?.toString() || ""}`);
      openaiWs = null;
      // Sessions can end (time limits, network blips). Reconnect while the extension is still connected.
      if (clientAlive) {
        clearTimeout(reconnectTimer);
        console.log(`Reconnecting to OpenAI in ${reconnectDelay} ms...`);
        reconnectTimer = setTimeout(connectOpenAI, reconnectDelay);
        reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      }
    });

    openaiWs.on("error", (err) => console.error("OpenAI WS error:", err.message));
  }

  connectOpenAI();

  // ===============================
  // Extension -> Server
  // ===============================

  clientWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "AUDIO" && msg.audioBase64) {
      if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return; // dropped while (re)connecting
      openaiWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: msg.audioBase64
      }));
      onAudioChunk(Buffer.from(msg.audioBase64, "base64"));
    }

    if (msg.type === "RESET") {
      liveByItem.clear();
      sendToClient({ type: "LIVE", text: "" });
      sendToClient({ type: "FINAL", text: "" });
    }
  });

  clientWs.on("close", () => {
    console.log("Extension disconnected");
    clientAlive = false;
    clearTimeout(reconnectTimer);
    clearTimeout(orderTimer);
    clearInterval(statsTimer);
    try { openaiWs?.close(); } catch { }
  });

  clientWs.on("error", (err) => console.error("Client WS error:", err.message));
});

console.log("Realtime translation server ready!");
