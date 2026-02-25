const API_BASE = "https://parent-panel-backend.onrender.com/api/auth";

// DOM Elements
const views = {
  parentLogin: document.getElementById("view-parent-login"),
  childSelect: document.getElementById("view-child-select"),
  pinEntry: document.getElementById("view-pin"),
  dashboard: document.getElementById("view-dashboard"),
  logoutConfirm: document.getElementById("view-logout-confirm"),
};

let selectedChildTemp = null; // PIN хийхээр сонгосон хүүхэд

// Init
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

// --- ACTIONS ---

// 1. Parent Login
document.getElementById("btn-p-login").onclick = async () => {
  const email = document.getElementById("p-email").value;
  const password = document.getElementById("p-pass").value;
  const errBox = document.getElementById("err-login");

  try {
    const res = await fetch(`${API_BASE}/parent-login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await res.json();

    if (data.success) {
      chrome.storage.local.set({
        parentToken: data.token,
        childrenList: data.children, // [{id:1, name:"Bat"}, ...]
      });
      renderChildList(data.children);
      showView("childSelect");
    } else {
      errBox.innerText = data.message || "Нэвтрэх бүтсэнгүй";
    }
  } catch (e) {
    errBox.innerText = "Сервертэй холбогдож чадсангүй";
  }
};

// 2. Child Select & PIN
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
  const pin = document.getElementById("child-pin").value;
  const errBox = document.getElementById("err-pin");

  try {
    const res = await fetch(`${API_BASE}/verify-pin`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ childId: selectedChildTemp.id, pin }),
    });
    const data = await res.json();

    if (data.success) {
      chrome.storage.local.set({
        activeChildId: selectedChildTemp.id,
        activeChildName: selectedChildTemp.name,
      });
      document.getElementById("active-user-name").innerText =
        selectedChildTemp.name;
      showView("dashboard");

      // "Login Required" хуудсыг хаах эсвэл refresh хийх
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        chrome.tabs.reload(tabs[0].id);
      });
    } else {
      errBox.innerText = "PIN код буруу байна";
    }
  } catch (e) {
    errBox.innerText = "Алдаа гарлаа";
  }
};

document.getElementById("btn-back-select").onclick = () =>
  showView("childSelect");

// 3. Switch User (Logout Child only)
document.getElementById("btn-switch-user").onclick = () => {
  chrome.storage.local.remove(["activeChildId", "activeChildName"], () => {
    showView("childSelect");
    // Reload current tab to force block
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      chrome.tabs.reload(tabs[0].id);
    });
  });
};

// 4. Parent Logout (Full Logout)
document.getElementById("btn-p-logout").onclick = () =>
  showView("logoutConfirm");
document.getElementById("btn-cancel-logout").onclick = () =>
  showView("childSelect");

document.getElementById("btn-confirm-logout").onclick = async () => {
  const password = document.getElementById("logout-pass").value;
  // Password verify API дуудна (Security)
  // ... (API call simulation)
  // if success:
  chrome.storage.local.clear(() => {
    location.reload(); // Reset popup
  });
};

// Helper: View Switcher
function showView(viewName) {
  Object.values(views).forEach((el) => el.classList.add("hidden"));
  views[viewName].classList.remove("hidden");
}
