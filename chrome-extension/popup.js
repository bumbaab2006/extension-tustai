const DEFAULT_AUTH_BASES = [
  "https://parent-panel-backend.onrender.com/api/auth",
  "http://localhost:5000/api/auth",
  "http://127.0.0.1:5000/api/auth",
];

function normalizeBase(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function toApiBase(authBase) {
  return authBase.replace(/\/auth$/, "");
}

async function getAuthBaseCandidates(preferStored = true) {
  const { authApiBaseUrl } = await chrome.storage.local.get(["authApiBaseUrl"]);
  const configured = normalizeBase(authApiBaseUrl);
  const seen = new Set();
  const bases = [];

  if (preferStored && configured) {
    seen.add(configured);
    bases.push(configured);
  }

  DEFAULT_AUTH_BASES.forEach((base) => {
    const normalized = normalizeBase(base);
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    bases.push(normalized);
  });

  if (!preferStored && configured && !seen.has(configured)) {
    bases.push(configured);
  }

  return bases;
}

async function cacheSelectedAuthBase(base) {
  await chrome.storage.local.set({
    authApiBaseUrl: base,
    apiBaseUrl: toApiBase(base),
  });
}

async function fetchAuthWithFailover(path, options, config = {}) {
  const {
    continueOnStatuses = [404, 405],
    preferStored = true,
  } = config;

  const bases = await getAuthBaseCandidates(preferStored);
  let lastError = null;
  let lastResponse = null;

  for (const base of bases) {
    try {
      const response = await fetch(`${base}${path}`, options);
      if (response.ok) {
        await cacheSelectedAuthBase(base);
        return response;
      }

      if (continueOnStatuses.includes(response.status)) {
        lastResponse = response;
        continue;
      }

      return response;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastResponse) {
    return lastResponse;
  }

  throw lastError || new Error("Auth server unreachable");
}

async function readJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

const views = {
  parentLogin: document.getElementById("view-parent-login"),
  childSelect: document.getElementById("view-child-select"),
  pinEntry: document.getElementById("view-pin"),
  dashboard: document.getElementById("view-dashboard"),
  logoutConfirm: document.getElementById("view-logout-confirm"),
};

let selectedChildTemp = null;

document.addEventListener("DOMContentLoaded", async () => {
  const data = await chrome.storage.local.get([
    "parentToken",
    "activeChildId",
    "activeChildName",
    "childrenList",
  ]);

  if (!data.parentToken) {
    showView("parentLogin");
  } else if (data.activeChildId) {
    document.getElementById("active-user-name").innerText =
      data.activeChildName;
    showView("dashboard");
  } else {
    renderChildList(data.childrenList || []);
    showView("childSelect");
  }
});

document.getElementById("btn-p-login").onclick = async () => {
  const rawEmail = document.getElementById("p-email").value.trim();
  const password = document.getElementById("p-pass").value;
  const errBox = document.getElementById("err-login");
  errBox.innerText = "";

  if (!rawEmail || !password) {
    errBox.innerText = "И-мэйл болон нууц үгээ оруулна уу";
    return;
  }

  const lowerEmail = rawEmail.toLowerCase();
  const emailCandidates = rawEmail === lowerEmail ? [rawEmail] : [rawEmail, lowerEmail];

  try {
    let lastResponse = null;
    let lastData = {};

    for (const email of emailCandidates) {
      const res = await fetchAuthWithFailover(
        "/parent-login",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email, password }),
        },
        {
          // If one backend has different DB and returns 401, try other known backends too.
          continueOnStatuses: [401, 404, 405],
          preferStored: false,
        },
      );

      const data = await readJsonSafe(res);
      if (res.ok && data.success) {
        chrome.storage.local.set({
          parentToken: data.token,
          childrenList: Array.isArray(data.children) ? data.children : [],
        });
        renderChildList(Array.isArray(data.children) ? data.children : []);
        showView("childSelect");
        return;
      }

      lastResponse = res;
      lastData = data;
      if (res.status !== 401) {
        break;
      }
    }

    errBox.innerText =
      lastData.message ||
      lastData.error ||
      (lastResponse?.status === 401
        ? "И-мэйл эсвэл нууц үг буруу байна"
        : "Нэвтрэх бүтсэнгүй");
  } catch {
    errBox.innerText =
      "Сервертэй холбогдож чадсангүй. Backend ажиллаж байгаа эсэхийг шалгана уу.";
  }
};

function renderChildList(children) {
  const container = document.getElementById("child-list");
  container.innerHTML = "";
  children.forEach((child) => {
    const btn = document.createElement("button");
    btn.className = "child-btn";
    btn.innerText = child.name;
    btn.onclick = () => {
      selectedChildTemp = child;
      document.getElementById("pin-title").innerText =
        `${child.name} - PIN код?`;
      document.getElementById("child-pin").value = "";
      showView("pinEntry");
    };
    container.appendChild(btn);
  });
}

document.getElementById("btn-verify-pin").onclick = async () => {
  const pin = document.getElementById("child-pin").value.trim();
  const errBox = document.getElementById("err-pin");
  errBox.innerText = "";

  if (!selectedChildTemp?.id) {
    errBox.innerText = "Хүүхдээ эхлээд сонгоно уу";
    return;
  }

  try {
    const res = await fetchAuthWithFailover(
      "/verify-pin",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ childId: selectedChildTemp.id, pin }),
      },
      { continueOnStatuses: [401, 404, 405] },
    );
    const data = await readJsonSafe(res);

    if (res.ok && data.success) {
      chrome.storage.local.set({
        activeChildId: selectedChildTemp.id,
        activeChildName: selectedChildTemp.name,
      });
      document.getElementById("active-user-name").innerText =
        selectedChildTemp.name;
      showView("dashboard");

      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs[0]?.id) {
          chrome.tabs.reload(tabs[0].id);
        }
      });
    } else {
      errBox.innerText = data.message || "PIN код буруу байна";
    }
  } catch {
    errBox.innerText = "Алдаа гарлаа";
  }
};

document.getElementById("btn-back-select").onclick = () =>
  showView("childSelect");

document.getElementById("btn-switch-user").onclick = () => {
  chrome.storage.local.remove(["activeChildId", "activeChildName"], () => {
    showView("childSelect");
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs[0]?.id) {
        chrome.tabs.reload(tabs[0].id);
      }
    });
  });
};

document.getElementById("btn-p-logout").onclick = () =>
  showView("logoutConfirm");
document.getElementById("btn-cancel-logout").onclick = () =>
  showView("childSelect");

document.getElementById("btn-confirm-logout").onclick = async () => {
  chrome.storage.local.clear(() => {
    location.reload();
  });
};

function showView(viewName) {
  Object.values(views).forEach((el) => el.classList.add("hidden"));
  views[viewName].classList.remove("hidden");
}
