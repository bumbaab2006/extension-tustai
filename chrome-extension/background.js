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

async function readJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

// Туслах функц: URL-аас домайныг ялгаж авах
function getDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, "");
  } catch (e) {
    return null;
  }
}

function normalizeChildId(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

async function getActiveChildState() {
  const storage = await chrome.storage.local.get([
    "activeChildId",
    "lastActiveChildId",
    "parentToken",
  ]);
  const activeChildId = normalizeChildId(storage.activeChildId);
  const lastActiveChildId = normalizeChildId(storage.lastActiveChildId);
  if (activeChildId) {
    if (activeChildId != lastActiveChildId) {
      try {
        await chrome.storage.local.set({ lastActiveChildId: activeChildId });
      } catch {
        // ignore storage errors
      }
    }
    return { activeChildId, parentToken: storage.parentToken };
  }

  const fallbackChildId = lastActiveChildId;
  if (fallbackChildId) {
    try {
      await chrome.storage.local.set({ activeChildId: fallbackChildId });
    } catch {
      // ignore storage errors
    }
    return { activeChildId: fallbackChildId, parentToken: storage.parentToken };
  }

  return { activeChildId: null, parentToken: storage.parentToken };
}

// 1. Browser эхлэх үед
chrome.runtime.onStartup.addListener(() => {
  chrome.storage.local.remove(["authApiBaseUrl", "apiBaseUrl"]);
});

// 2. Navigation Monitor (Сайт руу орох үед БЛОК хийх эсэхийг шалгах)
chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    if (details.frameId !== 0) return;
    if (!Number.isInteger(details.tabId) || details.tabId < 0) return;
    const url = details.url;
    if (!url.startsWith("http")) return;

    const authState = await getActiveChildState();
    const activeChildId = authState.activeChildId;
    if (!activeChildId) {
      if (authState.parentToken) {
        chrome.tabs.update(details.tabId, {
          url: chrome.runtime.getURL("login_required.html"),
        });
      }
      return;
    }

    try {
      const res = await fetch(`${BASE_URL}/check-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ childId: activeChildId, url: url }),
      });
      if (!res.ok) return;

      const data = await readJsonSafe(res);
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
  const normalizedTabId = Number.isFinite(Number(newTabId)) ? Number(newTabId) : null;
  if (!Number.isInteger(normalizedTabId)) {
    await stopTracking();
    return;
  }

  const tab = await chrome.tabs.get(normalizedTabId).catch(() => null);

  // Хэрэв хүчингүй таб бол (Settings, New Tab г.м) -> ЗОГСООНО
  if (!tab || !tab.url || !tab.url.startsWith("http")) {
    console.log("⏸️ Tracking Paused (Non-http page)");
    await stopTracking();
    return;
  }

  const authState = await getActiveChildState();
  const activeChildId = authState.activeChildId;
  if (!activeChildId) {
    if (authState.parentToken) {
      chrome.tabs.update(normalizedTabId, {
        url: chrome.runtime.getURL("login_required.html"),
      });
    }
    await stopTracking();
    return;
  }

  const newDomain = getDomain(tab.url);

  // Хэрэв өмнөх домайнтай ИЖИЛ байвл тоолуурыг ЗОГСООХГҮЙ
  if (trackingTimer && currentDomain === newDomain) {
    console.log(`🔄 Same domain (${newDomain}). Keeping timer alive.`);
    currentTabId = normalizedTabId;
    currentUrl = tab.url;
    return;
  }

  // Хэрэв өөр домайн бол (Facebook -> YouTube) -> ШИНЭЭР ЭХЭЛНЭ
  await stopTracking();
  startTracking(normalizedTabId, tab.url, newDomain);
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
  if (!Number.isInteger(currentTabId) || !currentDomain) return;

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
    const authState = await getActiveChildState();
    const activeChildId = authState.activeChildId;
    if (!activeChildId) return false;

    console.log(`📡 Sending ${durationSeconds}s Data (${reason}): ${url}`);

    const response = await fetch(`${BASE_URL}/track-time`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        childId: activeChildId,
        url: url,
        duration: durationSeconds,
      }),
    });

    if (!response.ok) {
      return false;
    }

    const data = await readJsonSafe(response);

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
