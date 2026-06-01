const { app, BrowserWindow, Menu, Tray, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const screenshot = require('screenshot-desktop');
const NodeWebcam = require('node-webcam');
const recorder = require('node-record-lpcm16');

let mainWindow;
let tray;
let agentState = {
  consented: false,
  monitoring: false,
  screenEnabled: false,
  webcamEnabled: false,
  audioEnabled: false,
  ws: null,
  deviceId: 'home-pc',
  deviceName: 'Home PC'
};

const CONFIG_FILE = path.join(app.getPath('userData'), 'agent-config.json');

// Load config
function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      agentState.consented = data.consented || false;
      agentState.deviceId = data.deviceId || 'home-pc';
      agentState.deviceName = data.deviceName || 'Home PC';
    }
  } catch (error) {
    console.error('Failed to load config:', error);
  }
}

// Save config
function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify({
      consented: agentState.consented,
      deviceId: agentState.deviceId,
      deviceName: agentState.deviceName
    }, null, 2));
  } catch (error) {
    console.error('Failed to save config:', error);
  }
}

// Create main window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 500,
    height: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    },
    icon: path.join(__dirname, 'icon.png')
  });

  mainWindow.loadFile('consent.html');
  mainWindow.webContents.openDevTools(); // Remove in production
}

// Create tray
function createTray() {
  const iconPath = path.join(__dirname, 'icon.png');
  tray = new Tray(iconPath);

  const contextMenu = Menu.buildFromTemplate([
    {
      label: agentState.monitoring ? '🔴 Մոնիտորինգ միացված է' : '⚪ Մոնիտորինգ անջատված է',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Բացել',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        } else {
          createWindow();
        }
      }
    },
    {
      label: agentState.monitoring ? 'Դադարեցնել' : 'Սկսել',
      click: () => {
        if (agentState.monitoring) {
          stopMonitoring();
        } else {
          startMonitoring();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Ելք',
      click: () => {
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
  tray.setToolTip('Powerrat Agent');
}

// Consent dialog
ipcMain.handle('consent-dialog', async (event, { consented }) => {
  if (consented) {
    agentState.consented = true;
    saveConfig();
    mainWindow.close();
    createTray();
    startMonitoring();
    return { ok: true };
  } else {
    app.quit();
    return { ok: false };
  }
});

// Start monitoring
function startMonitoring() {
  if (agentState.monitoring) return;
  agentState.monitoring = true;
  updateTray();
  connectWebSocket();
}

// Stop monitoring
function stopMonitoring() {
  agentState.monitoring = false;
  agentState.screenEnabled = false;
  agentState.webcamEnabled = false;
  agentState.audioEnabled = false;
  updateTray();
  if (agentState.ws) {
    agentState.ws.close();
    agentState.ws = null;
  }
}

// Update tray
function updateTray() {
  if (!tray) return;
  const contextMenu = Menu.buildFromTemplate([
    {
      label: agentState.monitoring ? '🔴 Մոնիտորինգ միացված է' : '⚪ Մոնիտորինգ անջատված է',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Բացել',
      click: () => {
        if (mainWindow) {
          mainWindow.show();
        } else {
          createWindow();
        }
      }
    },
    {
      label: agentState.monitoring ? 'Դադարեցնել' : 'Սկսել',
      click: () => {
        if (agentState.monitoring) {
          stopMonitoring();
        } else {
          startMonitoring();
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Ելք',
      click: () => {
        app.quit();
      }
    }
  ]);
  tray.setContextMenu(contextMenu);
}

// WebSocket connection
function connectWebSocket() {
  const SERVER_URL = process.env.SERVER_URL || 'ws://localhost:8080';
  const AGENT_TOKEN = process.env.AGENT_TOKEN || 'change-agent-token';

  const url = `${SERVER_URL}/agent?token=${encodeURIComponent(AGENT_TOKEN)}&device_id=${encodeURIComponent(agentState.deviceId)}&device_name=${encodeURIComponent(agentState.deviceName)}`;

  agentState.ws = new WebSocket(url);

  agentState.ws.on('open', () => {
    console.log('Connected to server');
    sendStatus();
  });

  agentState.ws.on('message', (data) => {
    try {
      const payload = JSON.parse(data);
      handleCommand(payload);
    } catch (error) {
      console.error('Failed to parse message:', error);
    }
  });

  agentState.ws.on('close', () => {
    console.log('Disconnected from server');
    if (agentState.monitoring) {
      setTimeout(connectWebSocket, 3000);
    }
  });

  agentState.ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
}

// Handle commands
async function handleCommand(payload) {
  if (payload.type !== 'command') return;

  const command = payload.command;

  if (command === 'screen_start') {
    agentState.screenEnabled = true;
    startScreenCapture();
  } else if (command === 'screen_stop') {
    agentState.screenEnabled = false;
  } else if (command === 'webcam_start') {
    agentState.webcamEnabled = true;
    startWebcamCapture();
  } else if (command === 'webcam_stop') {
    agentState.webcamEnabled = false;
  } else if (command === 'audio') {
    agentState.audioEnabled = true;
    startAudioRecording();
  } else if (command === 'all_stop') {
    agentState.screenEnabled = false;
    agentState.webcamEnabled = false;
    agentState.audioEnabled = false;
  }

  sendStatus();
}

// Screen capture
async function startScreenCapture() {
  if (!agentState.screenEnabled) return;

  try {
    const img = await screenshot({ format: 'jpg' });
    const base64 = img.toString('base64');
    sendMessage({
      type: 'frame',
      stream: 'screen',
      data: base64
    });
  } catch (error) {
    console.error('Screenshot error:', error);
  }

  if (agentState.screenEnabled) {
    setTimeout(startScreenCapture, 1000);
  }
}

// Webcam capture
async function startWebcamCapture() {
  if (!agentState.webcamEnabled) return;

  try {
    const opts = {
      width: 640,
      height: 480,
      quality: 100,
      delay: 0,
      saveFormat: 'jpg',
      verbose: false
    };

    NodeWebcam.capture('temp.jpg', opts, (err, data) => {
      if (err) {
        console.error('Webcam error:', err);
        return;
      }

      try {
        const img = fs.readFileSync('temp.jpg');
        const base64 = img.toString('base64');
        sendMessage({
          type: 'frame',
          stream: 'webcam',
          data: base64
        });
        fs.unlinkSync('temp.jpg');
      } catch (error) {
        console.error('Webcam processing error:', error);
      }

      if (agentState.webcamEnabled) {
        setTimeout(startWebcamCapture, 1000);
      }
    });
  } catch (error) {
    console.error('Webcam setup error:', error);
  }
}

// Audio recording
async function startAudioRecording() {
  if (!agentState.audioEnabled) return;

  const file = fs.createWriteStream('temp.wav');
  const rec = recorder.record({
    sampleRateHertz: 16000
  });

  rec.stream()
    .on('error', (err) => {
      console.error('Audio error:', err);
    })
    .pipe(file);

  setTimeout(() => {
    rec.stop();
    file.on('finish', () => {
      try {
        const audio = fs.readFileSync('temp.wav');
        const base64 = audio.toString('base64');
        sendMessage({
          type: 'audio',
          data: base64,
          filename: 'recording.wav'
        });
        fs.unlinkSync('temp.wav');
      } catch (error) {
        console.error('Audio processing error:', error);
      }
    });
  }, 10000);
}

// Send message
function sendMessage(payload) {
  if (agentState.ws && agentState.ws.readyState === WebSocket.OPEN) {
    agentState.ws.send(JSON.stringify(payload));
  }
}

// Send status
function sendStatus() {
  sendMessage({
    type: 'agent_status',
    message: 'Agent online',
    screen: agentState.screenEnabled,
    webcam: agentState.webcamEnabled
  });
}

// App events
app.on('ready', () => {
  loadConfig();
  if (agentState.consented) {
    createTray();
    startMonitoring();
  } else {
    createWindow();
  }
});

app.on('window-all-closed', () => {
  // Don't quit on window close, keep running in tray
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('before-quit', () => {
  stopMonitoring();
});

