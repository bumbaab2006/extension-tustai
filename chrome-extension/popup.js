const AUTH_API_BASE = "https://parent-panel-backend.onrender.com/api/auth";

async function readJsonSafe(response) {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function normalizeChildId(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : null;
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
    "parentEmail",
    "activeChildId",
    "activeChildName",
    "lastActiveChildId",
    "lastActiveChildName",
    "childrenList",
  ]);

  if (!data.parentToken) {
    showView("parentLogin");
  } else {
    const storedActiveId = normalizeChildId(data.activeChildId);
    const fallbackActiveId = normalizeChildId(data.lastActiveChildId);
    const activeChildId = storedActiveId || fallbackActiveId;
    const children = Array.isArray(data.childrenList)
      ? data.childrenList
      : [];
    const childFromList = activeChildId
      ? children.find((child) => normalizeChildId(child.id) === activeChildId)
      : null;
    const activeChildName =
      data.activeChildName || childFromList?.name || data.lastActiveChildName;

    if (activeChildId && activeChildName) {
      if (!storedActiveId || !data.activeChildName) {
        chrome.storage.local.set({ activeChildId, activeChildName });
      }
      document.getElementById("active-user-name").innerText = activeChildName;
      showView("dashboard");
    } else {
      renderChildList(children);
      showView("childSelect");
    }
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
  const emailCandidates =
    rawEmail === lowerEmail ? [rawEmail] : [rawEmail, lowerEmail];

  try {
    let lastResponse = null;
    let lastData = {};

    for (const email of emailCandidates) {
      const res = await fetch(`${AUTH_API_BASE}/parent-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      const data = await readJsonSafe(res);

      if (res.ok && data.success) {
        chrome.storage.local.set({
          parentToken: data.token,
          parentEmail: email,
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

  const normalizedChildId = normalizeChildId(selectedChildTemp.id);
  if (!normalizedChildId) {
    errBox.innerText = "Хүүхдийн ID буруу байна";
    return;
  }

  try {
    const res = await fetch(`${AUTH_API_BASE}/verify-pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ childId: normalizedChildId, pin }),
    });
    const data = await readJsonSafe(res);

    if (res.ok && data.success) {
      chrome.storage.local.set({
        activeChildId: normalizedChildId,
        activeChildName: selectedChildTemp.name,
        lastActiveChildId: normalizedChildId,
        lastActiveChildName: selectedChildTemp.name,
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
  chrome.storage.local.remove(
    ["activeChildId", "activeChildName", "lastActiveChildId", "lastActiveChildName"],
    () => {
      showView("childSelect");
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        if (tabs[0]?.id) {
          chrome.tabs.reload(tabs[0].id);
        }
      });
    },
  );
};

document.getElementById("btn-p-logout").onclick = () =>
  showView("logoutConfirm");
document.getElementById("btn-cancel-logout").onclick = () => {
  document.getElementById("err-logout").innerText = "";
  showView("childSelect");
};

document.getElementById("btn-confirm-logout").onclick = async () => {
  const password = document.getElementById("logout-pass").value.trim();
  const errBox = document.getElementById("err-logout");
  errBox.innerText = "";

  if (!password) {
    errBox.innerText = "Нууц үгээ оруулна уу";
    return;
  }

  const storage = await chrome.storage.local.get(["parentEmail"]);
  if (!storage.parentEmail) {
    errBox.innerText = "Имэйл олдсонгүй. Дахин нэвтэрнэ үү.";
    return;
  }

  try {
    const res = await fetch(`${AUTH_API_BASE}/verify-parent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: storage.parentEmail, password }),
    });
    const data = await readJsonSafe(res);
    if (res.ok && data.success) {
      chrome.storage.local.clear(() => {
        location.reload();
      });
      return;
    }

    errBox.innerText = data.message || data.error || "Нууц үг буруу байна";
  } catch {
    errBox.innerText = "Сервертэй холбогдож чадсангүй";
  }
};

function showView(viewName) {
  Object.values(views).forEach((el) => el.classList.add("hidden"));
  views[viewName].classList.remove("hidden");
}
