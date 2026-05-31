const state = {
  password: localStorage.getItem("viewerPassword") || "",
  socket: null,
  reconnectTimer: null,
  devices: [],
  selectedDeviceId: localStorage.getItem("selectedDeviceId") || ""
};

const els = {
  loginPanel: document.querySelector("#loginPanel"),
  loginForm: document.querySelector("#loginForm"),
  passwordInput: document.querySelector("#passwordInput"),
  dashboard: document.querySelector("#dashboard"),
  statusBadge: document.querySelector("#statusBadge"),
  notice: document.querySelector("#notice"),
  deviceList: document.querySelector("#deviceList"),
  selectedDevice: document.querySelector("#selectedDevice"),
  screenImage: document.querySelector("#screenImage"),
  webcamImage: document.querySelector("#webcamImage")
};

els.passwordInput.value = state.password;

els.loginForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const password = els.passwordInput.value.trim();
  if (!password) return;
  state.password = password;
  localStorage.setItem("viewerPassword", password);
  showDashboard();
  connect();
});

document.querySelectorAll("[data-command]").forEach((button) => {
  button.addEventListener("click", () => {
    sendCommand(button.dataset.command);
  });
});

if (state.password) {
  showDashboard();
  connect();
}

function showDashboard() {
  els.loginPanel.classList.add("hidden");
  els.dashboard.classList.remove("hidden");
}

function connect() {
  window.clearTimeout(state.reconnectTimer);
  if (state.socket) state.socket.close();

  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const url = `${protocol}//${location.host}/viewer?password=${encodeURIComponent(state.password)}`;
  const socket = new WebSocket(url);
  state.socket = socket;

  socket.addEventListener("open", () => {
    setNotice("Կապը բաց է։");
  });

  socket.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === "status") {
      updateDevices(payload.devices || []);
      return;
    }
    if (payload.type === "frame") {
      if (payload.deviceId !== state.selectedDeviceId) return;
      const target = payload.stream === "webcam" ? els.webcamImage : els.screenImage;
      target.src = `data:image/jpeg;base64,${payload.data}`;
      return;
    }
    if (payload.type === "notice" || payload.type === "agent_status") {
      if (!payload.deviceId || payload.deviceId === state.selectedDeviceId) {
        setNotice(payload.message || "");
      }
    }
  });

  socket.addEventListener("close", () => {
    setStatus(false);
    setNotice("Կապը փակվեց։ Կրկին միանում եմ...");
    state.reconnectTimer = window.setTimeout(connect, 2500);
  });
}

function updateDevices(devices) {
  state.devices = devices;
  if (!state.selectedDeviceId || !devices.some((device) => device.id === state.selectedDeviceId)) {
    state.selectedDeviceId = devices[0]?.id || "";
    localStorage.setItem("selectedDeviceId", state.selectedDeviceId);
    clearFrames();
  }
  renderDevices();
  const selected = getSelectedDevice();
  setStatus(Boolean(selected?.online));
  els.selectedDevice.textContent = selected ? selected.name : "Սարք չկա";
}

function renderDevices() {
  els.deviceList.innerHTML = "";
  if (!state.devices.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "Դեռ միացված համակարգիչ չկա։";
    els.deviceList.append(empty);
    return;
  }

  for (const device of state.devices) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "device-button";
    button.classList.toggle("selected", device.id === state.selectedDeviceId);
    button.innerHTML = `<span>${device.online ? "●" : "○"}</span><strong>${escapeHtml(device.name)}</strong>`;
    button.addEventListener("click", () => {
      state.selectedDeviceId = device.id;
      localStorage.setItem("selectedDeviceId", device.id);
      clearFrames();
      renderDevices();
      const selected = getSelectedDevice();
      setStatus(Boolean(selected?.online));
      els.selectedDevice.textContent = selected ? selected.name : "Սարք չկա";
    });
    els.deviceList.append(button);
  }
}

function sendCommand(command) {
  if (!state.selectedDeviceId) {
    setNotice("Նախ ընտրիր համակարգիչը։");
    return;
  }
  if (!state.socket || state.socket.readyState !== WebSocket.OPEN) {
    setNotice("Սերվերի հետ կապ չկա։");
    return;
  }
  state.socket.send(JSON.stringify({
    type: "command",
    deviceId: state.selectedDeviceId,
    command
  }));
}

function getSelectedDevice() {
  return state.devices.find((device) => device.id === state.selectedDeviceId);
}

function setStatus(online) {
  els.statusBadge.textContent = online ? "Գործակալը միացված է" : "Գործակալը անջատված է";
  els.statusBadge.classList.toggle("online", online);
}

function setNotice(text) {
  els.notice.textContent = text || "";
}

function clearFrames() {
  els.screenImage.removeAttribute("src");
  els.webcamImage.removeAttribute("src");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;"
  })[char]);
}
