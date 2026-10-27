# YT Realtime Translator

English | [中文](README.zh-CN.md)

A Chrome extension and Node.js relay server that turn the speech in a YouTube video into live translated subtitles. Tab audio is transcribed with the OpenAI Realtime API, each finished sentence is translated by an LLM, and the subtitles appear under the video (or over it in fullscreen) a moment after they are spoken.

## Features

- Live subtitles for any YouTube video, translated into the language you choose (Simplified Chinese by default)
- Shows the original-language transcript as it is being recognized, then the translation once the sentence is complete
- Subtitles appear while they are still being translated, rather than after the whole sentence is done
- Subtitles stay in spoken order even when transcriptions and translations finish out of order
- Each line is translated with the previous few lines as context, so names, terms and pronouns stay consistent
- Only speech is sent for transcription, which is what the API bills for
- Panel matches YouTube's light and dark themes and switches to caption style in fullscreen
- One click on the toolbar icon starts or stops translation for the current tab
- The OpenAI API key stays on the server and never reaches the browser

## How it works

```
 YouTube tab
     │ tab audio (chrome.tabCapture)
     ▼
 Offscreen document ── AudioWorklet: stereo float → mono PCM16 @ 24 kHz
     │ 200 ms chunks, base64 over WebSocket
     ▼
 Node.js relay server (ws://localhost:8787)
     │ 1. append audio to the OpenAI Realtime transcription session
     │ 2. voice activity detection decides where each sentence ends → commit
     │ 3. finished transcript → LLM translation
     │ 4. reorder by sequence number
     ▼
 LIVE (original text) / FINAL (translation) messages
     │ back over WebSocket → background service worker → content script
     ▼
 Subtitle panel under the video
```

**Audio capture.** Manifest V3 service workers cannot hold a media stream, so the background script gets a stream ID with `chrome.tabCapture.getMediaStreamId` and hands it to an offscreen document. There an AudioWorklet downmixes the tab audio to mono 16-bit PCM at 24 kHz, the format the Realtime API expects, and the page streams it to the server in 200 ms chunks.

**Sentence segmentation.** The transcription session runs with server-side turn detection turned off, so the relay decides when a sentence is finished. It measures the RMS level of each chunk: once it has seen at least 300 ms of speech followed by 600 ms of silence, it commits the audio buffer. Continuous speech or background music is committed every 7 s at most, and buffers that never contained speech are cleared.

**Cost.** Transcription is billed per minute of audio and is most of what the project costs to run, so the same voice activity detection decides what is worth sending: between sentences nothing goes upstream. The 400 ms of audio recorded just before speech was detected is sent along with it, so the first syllable is not clipped. The `[audio]` log line reports what share of the audio was forwarded.

**Latency.** Each subtitle waits for `END_SILENCE_MS` of silence, then transcription, then translation. The translation is streamed: the line appears as soon as its first few characters arrive and fills in from there, which removes most of the visible wait. Only the line that is next to be shown is streamed, so a segment that finished early still waits its turn and the order never breaks.

**Translation context.** Each line is translated with the last few lines, and their translations, replayed as earlier turns of the conversation. Translating a sentence on its own loses pronouns, names and terminology; passing the context back costs very little and fixes most of it. Context is recorded in the order subtitles were shown, not the order translations finished, so it always follows the spoken order.

**Ordering.** Each committed segment gets a sequence number. Transcriptions and translations can come back out of order, so finished translations wait in a buffer and are released strictly in sequence. If one segment never arrives, the server skips it after 5 s so the subtitles do not stall.

**Reliability.** If the connection to OpenAI drops, the server reconnects with exponential backoff (1 s up to 30 s) while the browser is still connected. Capture state is kept in `chrome.storage.session`, so it survives the service worker being shut down. The content script re-attaches the panel when YouTube re-renders the page, navigates to a new video, or enters fullscreen.

## Getting started

**Requirements:** Node.js 18 or newer, a recent version of Chrome, and an OpenAI API key with access to the Realtime API.

1. **Start the server**

   ```bash
   cd server
   npm install
   cp .env.example .env    # then put your OpenAI API key in .env
   npm start
   ```

   It should print `Server listening on ws://localhost:8787`.

2. **Load the extension**

   Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select the `extension` folder.

3. **Use it**

   Open a YouTube video and click the extension icon. The badge shows **ON** and subtitles appear under the video. Click the icon again to stop.

## Configuration

All settings live in `server/.env`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | (required) | Your OpenAI API key |
| `TRANSCRIBE_MODEL` | `gpt-live-transcribe` | Realtime transcription model |
| `TRANSLATE_MODEL` | `gpt-6-luna` | Model that translates each sentence |
| `TARGET_LANG` | `简体中文` | Language of the subtitles |
| `PORT` | `8787` | WebSocket port; the extension connects to `ws://localhost:8787` |
| `VAD_RMS_THRESHOLD` | `500` | Audio level counted as speech; raise it if music triggers subtitles |
| `MAX_SEGMENT_MS` | `7000` | Longest segment before it is sent for transcription |
| `END_SILENCE_MS` | `600` | Silence that ends a sentence; lower it for faster subtitles |
| `CONTEXT_TURNS` | `3` | Previous subtitles given to the translator as context; `0` turns it off |
| `TRANSLATE_REASONING_EFFORT` | `none` | How much a reasoning model thinks before translating |
| `TRANSLATE_TEMPERATURE` | unset | Only for older models; reasoning models reject it |
| `PRE_ROLL_MS` | `400` | Audio kept from just before speech was detected |

## Project structure

```
extension/
  manifest.json      Manifest V3 config
  background.js      toolbar toggle, tab capture, state, message routing
  offscreen.html/js  audio capture and WebSocket streaming
  pcm-worklet.js     AudioWorklet that converts audio to PCM16
  content.js         subtitle panel placement and rendering on YouTube
  subtitle.css       panel and fullscreen caption styles
server/
  server.js          relay: Realtime session, segmentation, ordering, reconnects
  translate.js       translation request to the LLM
  .env.example       configuration template
```

## Known limitations

- The server runs locally, and the extension only talks to `localhost:8787`
- Videos with loud background music may need a higher `VAD_RMS_THRESHOLD`, which also keeps music from being sent for transcription
- Every minute of audio is billed to your OpenAI account for both transcription and translation

## Tech stack

JavaScript, Node.js, WebSocket (`ws`), OpenAI Realtime API, Chrome Extensions (Manifest V3: offscreen documents, tabCapture, AudioWorklet)
