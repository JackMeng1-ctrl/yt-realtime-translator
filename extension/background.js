// MV3 service worker: creates the offscreen document, gets the tab's media streamId,
// and forwards LIVE/FINAL subtitle messages from offscreen to the content script.
//
// An MV3 service worker is shut down after ~30s idle and its global variables are lost,
// so capture state is kept in chrome.storage.session instead of plain variables.

const STATE_KEY = "captureState"; // { capturing: boolean, tabId: number | null }

async function getState() {
  const stored = await chrome.storage.session.get(STATE_KEY);
  return stored[STATE_KEY] || { capturing: false, tabId: null };
}

async function setState(state) {
  await chrome.storage.session.set({ [STATE_KEY]: state });
  await chrome.action.setBadgeText({ text: state.capturing ? "ON" : "" });
}

console.log("Service worker loaded");

// Forward LIVE/FINAL messages from offscreen to the captured tab's content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== "LIVE" && msg.type !== "FINAL") return;

  getState().then(({ capturing, tabId }) => {
    if (!capturing || tabId == null) return;
    chrome.tabs.sendMessage(tabId, { type: msg.type, text: msg.text })
      .catch(err => console.warn("Failed to send to content script:", err.message));
  });
});

// Lets the content script ask whether its tab is being captured (e.g. after a page reload)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== "GET_STATUS") return;
  getState().then(({ capturing, tabId }) => {
    sendResponse({ capturing: capturing && sender.tab?.id === tabId });
  });
  return true; // keep the channel open for the async response
});

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) {
    await chrome.offscreen.closeDocument();
    console.log("Closed existing offscreen");
  }

  // Register the ready listener BEFORE creating the document so the signal can't be missed
  const ready = new Promise((resolve) => {
    const listener = (msg) => {
      if (msg.type === "OFFSCREEN_READY") {
        chrome.runtime.onMessage.removeListener(listener);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(listener);
    setTimeout(() => {
      chrome.runtime.onMessage.removeListener(listener);
      resolve();
    }, 2000);
  });

  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    // USER_MEDIA, not AUDIO_PLAYBACK: AUDIO_PLAYBACK documents are closed
    // automatically after 30 seconds without audio (e.g. when the video is paused).
    reasons: ["USER_MEDIA"],
    justification: "Capture tab audio for real-time transcription"
  });

  await ready;
  console.log("Created new offscreen document");
}

async function startCapture(tabId) {
  await ensureOffscreen();

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });

  await setState({ capturing: true, tabId });
  await chrome.runtime.sendMessage({ type: "OFFSCREEN_START", streamId }).catch(() => {});
  chrome.tabs.sendMessage(tabId, { type: "STATUS", capturing: true }).catch(() => {});
  console.log("Capture started on tab", tabId);
}

async function stopCapture() {
  const { tabId } = await getState();
  await chrome.runtime.sendMessage({ type: "OFFSCREEN_STOP" }).catch(() => {});
  await setState({ capturing: false, tabId: null });
  if (tabId != null) {
    chrome.tabs.sendMessage(tabId, { type: "STATUS", capturing: false }).catch(() => {});
  }

  if (await chrome.offscreen.hasDocument?.()) {
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  console.log("Capture stopped");
}

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  try {
    const { capturing } = await getState();
    if (capturing) {
      await stopCapture();
    } else {
      await startCapture(tab.id);
    }
  } catch (e) {
    console.error("Capture toggle failed:", e);
    await setState({ capturing: false, tabId: null });
  }
});

// Stop cleanly if the captured tab is closed
chrome.tabs.onRemoved.addListener(async (tabId) => {
  const { capturing, tabId: activeTabId } = await getState();
  if (capturing && activeTabId === tabId) {
    await stopCapture();
  }
});
