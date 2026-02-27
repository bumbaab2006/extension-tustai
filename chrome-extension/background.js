const BASE_URL = "https://parent-panel-backend.onrender.com/api";
const DEBUG_LOGS = false;

// Глобал төлөвүүдийг Service Worker дотор барих (унтахад устана гэдгийг санаарай)
let currentTracking = {
  tabId: null,
  domain: null,
  url: null,
  startTime: null,
};

console.log("🚀 Safe-kid Service Worker Active");

// Туслах функц: JSON-ыг найдвартай унших
async function readJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

// Домайн ялгах
function getDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function normalizeChildId(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
}

// Хүүхдийн төлвийг Storage-аас авах (parent/child төлөвийг хамтад нь)
async function getActiveChildState() {
  const storage = await chrome.storage.local.get([
    "activeChildId",
    "lastActiveChildId",
    "parentToken",
  ]);
  const activeChildId = normalizeChildId(storage.activeChildId);
  const lastActiveChildId = normalizeChildId(storage.lastActiveChildId);
  if (activeChildId) {
    if (activeChildId !== lastActiveChildId) {
      try {
        await chrome.storage.local.set({ lastActiveChildId: activeChildId });
      } catch {
        // ignore
      }
    }
    return { activeChildId, parentToken: storage.parentToken };
  }

  if (lastActiveChildId) {
    try {
      await chrome.storage.local.set({ activeChildId: lastActiveChildId });
    } catch {
      // ignore
    }
    return { activeChildId: lastActiveChildId, parentToken: storage.parentToken };
  }

  return { activeChildId: null, parentToken: storage.parentToken };
}

const SEARCH_QUERY_PARAMS = {
  "google.com": ["q"],
  "bing.com": ["q"],
  "duckduckgo.com": ["q"],
  "yahoo.com": ["p"],
  "yandex.com": ["text"],
  "youtube.com": ["search_query"],
  "m.youtube.com": ["search_query"],
};

const BLOCKED_KEYWORDS = [
  "porn",
  "porno",
  "xxx",
  "adult",
  "nsfw",
  "nude",
  "naked",
  "sex",
  "sexy",
  "tits",
  "boobs",
  "blowjob",
  "anal",
  "hentai",
  "onlyfans",
  "camgirl",
  "escort",
  "эротик",
  "секс",
  "порно",
  "насанд хүрэгч",
];

const BLOCKED_REGEX = [
  /(\b|\D)18\s*\+(\b|\D)/i,
  /(\b|\D)\+\s*18(\b|\D)/i,
  /(\b|\D)18\s*plus(\b|\D)/i,
  /(\b|\D)18\s*-?\s*year/i,
  /(\b|\D)18\s*\+?\s*contents?/i,
];


function normalizeText(value) {
  return decodeURIComponent(String(value || ""))
    .toLowerCase()
    .replace(/\+/g, " ")
    .trim();
}

function extractSearchText(urlObj, domain) {
  const params = SEARCH_QUERY_PARAMS[domain] || [];
  const fallbackParams = ["q", "p", "query", "search", "keyword", "search_query", "text"];
  const parts = [];
  const sourceParams = params.length ? params : fallbackParams;
  for (const param of sourceParams) {
    const value = urlObj.searchParams.get(param);
    if (value) parts.push(value);
  }
  return normalizeText(parts.join(" "));
}

function isBlockedByLocalRules(url) {
  try {
    const urlObj = new URL(url);
    const domain = urlObj.hostname.replace(/^www\./, "");

    const searchText = extractSearchText(urlObj, domain);
    const rawText = `${urlObj.pathname} ${urlObj.search}`;
    const pathText = normalizeText(rawText);
    const combined = `${searchText} ${pathText}`;

    if (BLOCKED_REGEX.some((regex) => regex.test(rawText) || regex.test(combined))) {
      return true;
    }

    return BLOCKED_KEYWORDS.some((keyword) => combined.includes(keyword));
  } catch {
    return false;
  }
}

// 1. САЙТ БЛОКЛОХ ЛОГИК
chrome.webNavigation.onBeforeNavigate.addListener(
  async (details) => {
    if (details.frameId !== 0) return;
    if (!Number.isInteger(details.tabId) || details.tabId < 0) return;
    const url = details.url;
    if (!url.startsWith("http")) return;

    const authState = await getActiveChildState();
    const childId = authState.activeChildId;
    if (!childId) {
      if (authState.parentToken) {
        chrome.tabs.update(details.tabId, {
          url: chrome.runtime.getURL("login_required.html"),
        });
      }
      return;
    }

    if (isBlockedByLocalRules(url)) {
      if (DEBUG_LOGS) {
        console.log("🔒 Local keyword block:", url);
      }
      chrome.tabs.update(details.tabId, {
        url: chrome.runtime.getURL("blocked.html"),
      });
      return;
    }

    try {
      // Timeout нэмж өгснөөр сервер удах үед гацахаас сэргийлнэ
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000);

      const res = await fetch(`${BASE_URL}/check-url`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ childId, url }),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (res.ok) {
        const data = await readJsonSafe(res);
        if (data.action === "BLOCK") {
          chrome.tabs.update(details.tabId, {
            url: chrome.runtime.getURL("blocked.html"),
          });
        }
      }
    } catch (error) {
      if (DEBUG_LOGS) {
        const reason = error && error.name === "AbortError"
          ? "timeout"
          : error?.message || "unknown error";
        console.warn("Safety check skipped:", reason);
      }
    }
  },
  { url: [{ schemes: ["http", "https"] }] },
);

// 2. ХУГАЦАА ХЯНАХ ЛОГИК (Ухаалаг хувилбар)
async function handleTabChange(tabId) {
  const normalizedTabId = Number.isInteger(Number(tabId)) ? Number(tabId) : null;
  if (!Number.isInteger(normalizedTabId)) {
    await stopAndFlush();
    return;
  }

  const tab = await chrome.tabs.get(normalizedTabId).catch(() => null);
  if (!tab || !tab.url || !tab.url.startsWith("http")) {
    await stopAndFlush();
    return;
  }

  const authState = await getActiveChildState();
  if (!authState.activeChildId) return;

  const domain = getDomain(tab.url);

  // Хэрэв домайн өөрчлөгдсөн бол хуучныг нь сервер рүү илгээгээд шинийг эхлүүлнэ
  if (currentTracking.domain !== domain) {
    await stopAndFlush();
    currentTracking = {
      tabId: normalizedTabId,
      domain: domain,
      url: tab.url,
      startTime: Date.now(),
    };
  }
}

async function stopAndFlush() {
  if (currentTracking.startTime) {
    const duration = Math.floor((Date.now() - currentTracking.startTime) / 1000);
    if (duration > 0) {
      const authState = await getActiveChildState();
      const childId = authState.activeChildId;
      if (childId) {
        // "keepalive: true" нь Service Worker унтсан ч fetch-ийг дуусгахад тусалдаг
        fetch(`${BASE_URL}/track-time`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            childId,
            url: currentTracking.url,
            duration,
          }),
          keepalive: true,
        }).catch((err) => console.error("Flush failed", err));
      }
    }
  }
  currentTracking = { tabId: null, domain: null, url: null, startTime: null };
}

// Event Listeners
chrome.tabs.onActivated.addListener((info) => handleTabChange(info.tabId));
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.status === "complete" && tab.active) handleTabChange(id);
});
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    await stopAndFlush();
  } else {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (tab) handleTabChange(tab.id);
  }
});
