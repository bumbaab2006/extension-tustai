const BASE_URL = "https://parent-panel-backend.onrender.com/api";
const PING_INTERVAL_MS = 60000; // Сервер рүү 60 сек тутам batch илгээх
const TICK_INTERVAL_MS = 5000; // 5 сек тутам локалд хугацаа нэмэх

let trackingTimer = null; // Тоолуурын ID
let currentTabId = null; // Одоогийн идэвхтэй таб ID
let currentDomain = null; // Одоогийн домайн (Жишээ нь: instagram.com)
let currentUrl = null; // Одоогийн URL
let accumulatedMs = 0; // Хуримтлагдсан хугацаа
let lastTickAt = 0; // Сүүлийн tick цаг
let lastFlushAt = 0; // Сүүлийн сервер рүү илгээсэн цаг
let isFlushing = false;

console.log("🚀 Background Monitor Loaded (Domain-Based Tracking)");

// Туслах функц: URL-аас домайныг ялгаж авах
function getDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, "");
  } catch (e) {
    return null;
  }
}

// 1. Browser эхлэх үед
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove("activeChildId");
});

// 2. Navigation Monitor (Сайт руу орох үед БЛОК хийх эсэхийг шалгах)
chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    if (details.frameId !== 0) return;
    const url = details.url;
    if (!url.startsWith("http")) return;

    const storage = await chrome.storage.local.get(["activeChildId"]);
    if (!storage.activeChildId) return;

    try {
      const res = await fetch(`${BASE_URL}/check-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ childId: storage.activeChildId, url: url }),
      });
      const data = await res.json();
      if (data.action === "BLOCK") {
        chrome.tabs.update(details.tabId, {
          url: chrome.runtime.getURL("blocked.html"),
        });
      }
    } catch (e) {
      console.error("Check URL failed:", e);
    }
  },
  { url: [{ schemes: ["http", "https"] }] },
);

// ============================================
// 3. УХААЛАГ TRACKING LOGIC (DOMAINS BASED)
// ============================================

// A. Таб идэвхжих үед
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  handleTabChange(activeInfo.tabId);
});

// B. Таб шинэчлэгдэх үед (URL солигдох)
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.active) {
    handleTabChange(tabId);
  }
});

// C. Цонхны фокус өөрчлөгдөхөд
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await stopTracking();
    return;
  }

  const tabs = await chrome.tabs.query({ active: true, windowId });
  if (tabs[0]?.id) {
    handleTabChange(tabs[0].id);
  }
});

async function handleTabChange(newTabId) {
  const tab = await chrome.tabs.get(newTabId).catch(() => null);

  // Хэрэв хүчингүй таб бол (Settings, New Tab г.м) -> ЗОГСООНО
  if (!tab || !tab.url || !tab.url.startsWith("http")) {
    console.log("⏸️ Tracking Paused (Non-http page)");
    await stopTracking();
    return;
  }

  const newDomain = getDomain(tab.url);

  // Хэрэв өмнөх домайнтай ИЖИЛ байвл тоолуурыг ЗОГСООХГҮЙ
  if (trackingTimer && currentDomain === newDomain) {
    console.log(`🔄 Same domain (${newDomain}). Keeping timer alive.`);
    currentTabId = newTabId;
    currentUrl = tab.url;
    return;
  }

  // Хэрэв өөр домайн бол (Facebook -> YouTube) -> ШИНЭЭР ЭХЭЛНЭ
  await stopTracking();
  startTracking(newTabId, tab.url, newDomain);
}

async function stopTracking() {
  await flushPending("stop");
  if (trackingTimer) {
    console.log("🛑 Timer Stopped/Reset");
    clearInterval(trackingTimer);
    trackingTimer = null;
  }
  currentTabId = null;
  currentDomain = null;
  currentUrl = null;
  accumulatedMs = 0;
  lastTickAt = 0;
  lastFlushAt = 0;
}

function startTracking(tabId, url, domain) {
  console.log(`⏱️ New Timer Started for Domain: ${domain}`);

  currentTabId = tabId;
  currentDomain = domain;
  currentUrl = url;
  accumulatedMs = 0;
  lastTickAt = Date.now();
  lastFlushAt = Date.now();

  if (trackingTimer) clearInterval(trackingTimer);
  trackingTimer = setInterval(tick, TICK_INTERVAL_MS);
}

async function tick() {
  if (!currentTabId || !currentDomain) return;

  const now = Date.now();
  accumulatedMs += now - (lastTickAt || now);
  lastTickAt = now;

  const currentTab = await chrome.tabs.get(currentTabId).catch(() => null);
  if (
    !currentTab ||
    !currentTab.active ||
    !currentTab.url?.startsWith("http")
  ) {
    await stopTracking();
    return;
  }

  const domain = getDomain(currentTab.url);
  if (domain !== currentDomain) {
    await handleTabChange(currentTabId);
    return;
  }

  currentUrl = currentTab.url;

  if (now - lastFlushAt >= PING_INTERVAL_MS) {
    await flushPending("interval");
  }
}

async function flushPending(reason) {
  if (isFlushing) return;
  if (!currentTabId || !currentDomain || !currentUrl) return;

  const seconds = Math.floor(accumulatedMs / 1000);
  if (seconds < 1) return;

  isFlushing = true;
  const success = await sendPing(currentUrl, currentTabId, seconds, reason);
  if (success) {
    accumulatedMs -= seconds * 1000;
    lastFlushAt = Date.now();
  }
  isFlushing = false;
}

// Сервер рүү мэдээлэл илгээх
async function sendPing(url, tabId, durationSeconds, reason) {
  try {
    const storage = await chrome.storage.local.get(["activeChildId"]);
    if (!storage.activeChildId) return false;

    console.log(`📡 Sending ${durationSeconds}s Data (${reason}): ${url}`);

    const response = await fetch(`${BASE_URL}/track-time`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        childId: storage.activeChildId,
        url: url,
        duration: durationSeconds,
      }),
    });

    const data = await response.json();

    if (data.status === "BLOCK") {
      await stopTracking();
      chrome.tabs.update(tabId, { url: chrome.runtime.getURL("blocked.html") });
    }

    return true;
  } catch (error) {
    console.warn("⚠️ Ping failed:", error.message);
    return false;
  }
}
