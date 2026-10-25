// Content script: renders the live translation panel on the YouTube watch page.
//
// Normal view -> a caption panel directly below the video (above the title),
//                styled with YouTube's own theme colors so it fits light and dark mode.
// Fullscreen  -> broadcast-style captions overlaid on the bottom of the video.

const MAX_HISTORY = 2; // previous translated lines kept above the current one

let capturing = false;
let history = []; // older translated lines, oldest first
let current = ""; // latest translated line
let live = "";    // original-language text still being transcribed

// ---------------- DOM ----------------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

const root = el("div", "ytlt-hidden");
root.id = "yt-live-translation";

const header = el("div", "ytlt-header");
header.append(
  el("span", "ytlt-dot"),
  el("span", "ytlt-title", "实时翻译"),
  el("span", "ytlt-meta", "AI 生成")
);

const historyEl = el("div", "ytlt-history");

const currentEl = el("div", "ytlt-current ytlt-empty");
const currentText = el("span");
currentEl.append(currentText);

const liveEl = el("div", "ytlt-live ytlt-empty");
const liveText = el("span");
liveEl.append(liveText);

const placeholderEl = el("div", "ytlt-placeholder ytlt-empty", "正在聆听…");

root.append(header, historyEl, currentEl, liveEl, placeholderEl);

console.log("Content script loaded on", window.location.href);

function render({ animate = false } = {}) {
  root.classList.toggle("ytlt-hidden", !(capturing || current || live));
  root.classList.toggle("ytlt-capturing", capturing);

  historyEl.replaceChildren(
    ...history.map((text) => {
      const line = el("div", "ytlt-line");
      line.append(el("span", null, text));
      return line;
    })
  );

  currentText.textContent = current;
  currentEl.classList.toggle("ytlt-empty", !current);

  liveText.textContent = live;
  liveEl.classList.toggle("ytlt-empty", !live);

  placeholderEl.classList.toggle("ytlt-empty", !(capturing && !current && !live));

  if (animate) {
    currentEl.classList.remove("ytlt-enter");
    void currentEl.offsetWidth; // restart the animation
    currentEl.classList.add("ytlt-enter");
  }
}

function clearText() {
  history = [];
  current = "";
  live = "";
}

// ---------------- Placement ----------------
const findPlayer = () =>
  document.querySelector("#movie_player") || document.querySelector(".html5-video-player");

// The column under the player on the watch page (holds the title, channel row, etc.)
const findBelow = () => document.querySelector("ytd-watch-flexy #below");

function setMode(mode) {
  root.classList.toggle("ytlt-below", mode === "below");
  root.classList.toggle("ytlt-overlay", mode === "overlay");
}

function placeSubtitles() {
  const below = findBelow();

  if (!document.fullscreenElement && below) {
    if (below.firstElementChild !== root) below.prepend(root);
    setMode("below");
    return;
  }

  // Fullscreen, or the page layout has no "below" column: overlay inside the player
  const player = findPlayer();
  if (player && root.parentElement !== player) player.appendChild(root);
  setMode("overlay");
}

// YouTube is a single-page app that renders progressively and re-renders parts of
// the page, so keep the panel in the right place instead of attaching it only once.
placeSubtitles();
setInterval(placeSubtitles, 1000);
document.addEventListener("fullscreenchange", placeSubtitles);

document.addEventListener("yt-navigate-finish", () => {
  clearText();
  render();
  placeSubtitles();
});

// ---------------- Messages ----------------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "STATUS") {
    capturing = !!msg.capturing;
    if (!capturing) clearText();
    render();
  }

  if (msg.type === "LIVE") {
    live = msg.text || "";
    if (live) capturing = true;
    render();
  }

  if (msg.type === "FINAL") {
    const text = msg.text || "";
    if (!text) {
      clearText();
      render();
      return;
    }
    capturing = true;
    if (current) history = [...history, current].slice(-MAX_HISTORY);
    current = text;
    render({ animate: true });
  }
});

// If the page was reloaded while capture is running, pick the state back up
chrome.runtime.sendMessage({ type: "GET_STATUS" })
  .then((res) => {
    if (res?.capturing) {
      capturing = true;
      render();
    }
  })
  .catch(() => {});
