import os, time, json, math, asyncio, numpy as np, webrtcvad, requests, logging
from typing import Dict, Optional, Tuple
from faster_whisper import WhisperModel
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

# --- Config ---
LANG            = "es"  # fuerza español
MODEL_SIZE      = os.getenv("MODEL_SIZE","small")            # small|medium
DEVICE          = os.getenv("DEVICE","cpu")                  # cuda|cpu
COMPUTE_TYPE    = os.getenv("COMPUTE_TYPE","int8")           # cpu: int8/int8_float16 | gpu: float16
SAMPLE_RATE_IN  = int(os.getenv("SAMPLE_RATE","16000"))      # sample rate de entrada real (8k/16k)
SAMPLE_RATE     = 16000                                      # normalizamos a 16k para Whisper
DECODE_INTERVAL = float(os.getenv("DECODE_INTERVAL","0.25")) # s
SLIDING_S       = float(os.getenv("SLIDING_S","1.0"))        # s para parciales
MIN_DECODE_S    = float(os.getenv("MIN_DECODE_S","0.6"))     # s mínimo para decodificar
ENDPOINT_MS     = int(os.getenv("ENDPOINT_MS","500"))        # ms silencio para finalizar turno
RELAY_URL       = os.getenv("RELAY_URL","http://127.0.0.1:7070/event")
ENERGY_THRESH   = int(os.getenv("ENERGY_THRESH","350"))      # RMS simple (ajusta)
CTX_LIMIT_CHARS = int(os.getenv("CTX_LIMIT_CHARS","2000"))
RING_SEC_MAX    = 3.0                                        # segundos de buffer por sesión

# Debug de audio y logging
FRAME_LOG_SEC   = float(os.getenv("FRAME_LOG_SEC", "5.0"))     # 0 = desactivar
LOG_PARTIALS    = os.getenv("LOG_PARTIALS", "1").lower() in ("1","true","yes","on")
LOG_FINALS      = os.getenv("LOG_FINALS", "1").lower() in ("1","true","yes","on")
PARTIAL_REQUIRE_VOICE = os.getenv("PARTIAL_REQUIRE_VOICE", "1").lower() in ("1","true","yes","on")
PARTIAL_RECENT_VOICE_MS = int(os.getenv("PARTIAL_RECENT_VOICE_MS", "400"))
VAD_MODE        = int(os.getenv("VAD_MODE", "3"))             # 0-3 (3 = más agresivo)

# --- Modelo ---
# --- Logging ---
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()
LOG_FILE = os.getenv("LOG_FILE", "").strip()

logger = logging.getLogger("stt")
logger.setLevel(getattr(logging, LOG_LEVEL, logging.INFO))
_fmt = logging.Formatter("%(asctime)s %(levelname)s [%(name)s] %(message)s")
_ch = logging.StreamHandler()
_ch.setFormatter(_fmt)
logger.addHandler(_ch)
if LOG_FILE:
    try:
        _fh = logging.FileHandler(LOG_FILE)
        _fh.setFormatter(_fmt)
        logger.addHandler(_fh)
    except Exception:
        logger.warning("No se pudo abrir LOG_FILE='%s' para escritura", LOG_FILE)

logger.info("Cargando faster-whisper (%s) en %s/%s...", MODEL_SIZE, DEVICE, COMPUTE_TYPE)
logger.info(
    "Config STT: SAMPLE_RATE_IN=%d -> SAMPLE_RATE=%d, ENERGY_THRESH=%d, FRAME_LOG_SEC=%.1f, LOG_PARTIALS=%s, LOG_FINALS=%s",
    SAMPLE_RATE_IN, SAMPLE_RATE, ENERGY_THRESH, FRAME_LOG_SEC, LOG_PARTIALS, LOG_FINALS
)
MODEL_PATH = os.getenv("MODEL_PATH", "").strip()
if MODEL_PATH and os.path.isdir(MODEL_PATH):
    model = WhisperModel(MODEL_PATH, device=DEVICE, compute_type=COMPUTE_TYPE)
else:
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)

# --- App ---
app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])

vad = webrtcvad.Vad(max(0, min(3, VAD_MODE)))  # 0-3

def now_s() -> float:
    return time.time()

def normalize_es(text:str)->str:
    t = text.replace(" ,", ",").replace(" .", ".").replace(" !","!").replace(" ?","?")
    return t.strip()

def is_rtp(packet: bytes) -> bool:
    if len(packet) < 12:
        return False
    return ((packet[0] >> 6) & 0x03) == 2

def parse_rtp(packet: bytes) -> Tuple[bytes, Optional[int]]:
    # Devuelve (payload, payload_type) o (packet, None) si no se pudo parsear
    if len(packet) < 12:
        return packet, None
    b0, b1 = packet[0], packet[1]
    csrc_count = b0 & 0x0F
    has_ext = (b0 & 0x10) != 0
    pt = b1 & 0x7F  # payload type 7 bits
    header_len = 12 + (csrc_count * 4)
    if has_ext:
        if len(packet) < header_len + 4:
            return packet, pt
        ext_len_words = int.from_bytes(packet[header_len+2:header_len+4], "big")
        header_len += 4 + (ext_len_words * 4)
    if header_len >= len(packet):
        return packet, pt
    return packet[header_len:], pt

# --- G.711 decoders (mu-law / A-law) ---
# Tablas de look-up para velocidad
_ULAW_TO_LINEAR = np.empty(256, dtype=np.int16)
_ALAW_TO_LINEAR = np.empty(256, dtype=np.int16)

def _init_g711_tables():
    # mu-law
    for i in range(256):
        u = ~i & 0xFF
        sign = u & 0x80
        exponent = (u >> 4) & 0x07
        mantissa = u & 0x0F
        sample = ((mantissa << 3) + 0x84) << exponent
        sample -= 0x84
        _ULAW_TO_LINEAR[i] = -sample if sign else sample
    # A-law
    for i in range(256):
        a = i ^ 0x55
        sign = a & 0x80
        exponent = (a >> 4) & 0x07
        mantissa = a & 0x0F
        if exponent == 0:
            sample = (mantissa << 4) + 8
        else:
            sample = ((mantissa << 4) + 0x108) << (exponent - 1)
        _ALAW_TO_LINEAR[i] = sample - 4 if sign == 0 else -(sample - 4)

_init_g711_tables()

def decode_g711_ulaw(payload: bytes) -> np.ndarray:
    b = np.frombuffer(payload, dtype=np.uint8)
    return _ULAW_TO_LINEAR[b]

def decode_g711_alaw(payload: bytes) -> np.ndarray:
    b = np.frombuffer(payload, dtype=np.uint8)
    return _ALAW_TO_LINEAR[b]

def resample_8k_to_16k(mono_int16_8k: np.ndarray) -> np.ndarray:
    # Upsample lineal simple x2 (8k->16k). Para mejor calidad usa sinc/soxr fuera de ruta caliente.
    if mono_int16_8k.size == 0: 
        return mono_int16_8k
    x = mono_int16_8k.astype(np.float32)
    y = np.empty(x.size * 2, dtype=np.float32)
    y[0::2] = x
    # interp lineal entre muestras
    if x.size > 1:
        y[1:-1:2] = (x[:-1] + x[1:]) / 2.0
        y[-1] = x[-1]
    else:
        # si sólo hay 1 muestra, duplica
        y[1] = x[0]
    return np.clip(y, -32768, 32767).astype(np.int16)

class RingBuffer:
    def __init__(self, capacity_samples: int):
        self.capacity = capacity_samples
        self.buf = np.zeros(capacity_samples, dtype=np.int16)
        self.w = 0
        self.filled = 0
    def push(self, data: np.ndarray):
        n = data.size
        if n >= self.capacity:
            self.buf[:] = data[-self.capacity:]
            self.w = 0
            self.filled = self.capacity
            return
        end = self.w + n
        if end <= self.capacity:
            self.buf[self.w:end] = data
        else:
            p1 = self.capacity - self.w
            self.buf[self.w:] = data[:p1]
            self.buf[:end - self.capacity] = data[p1:]
        self.w = (self.w + n) % self.capacity
        self.filled = min(self.capacity, self.filled + n)
    def tail(self, n_samples: int) -> np.ndarray:
        n = min(n_samples, self.filled)
        start = (self.w - n) % self.capacity
        if start + n <= self.capacity:
            return self.buf[start:start+n].copy()
        else:
            p1 = self.capacity - start
            return np.concatenate((self.buf[start:], self.buf[:n - p1]))
    def all(self) -> np.ndarray:
        return self.tail(self.filled)

class Session:
    def __init__(self, call_id:str, speaker:str):
        self.call_id = call_id
        self.speaker = speaker
        self.rb = RingBuffer(int(SAMPLE_RATE * RING_SEC_MAX))
        self.last_emit = 0.0
        self.last_voice = now_s()
        self.turn_idx = 0
        self.open_turn: Optional[str] = None
        self.ctx_text = ""
        self.lock = asyncio.Lock()  # por si abres varios writers por sesión
        # métricas de audio (ventana)
        self.win_frames = 0
        self.win_samples = 0
        self.win_bytes = 0
        self.last_energy = 0.0
        self.last_vad = False
        self.last_log = now_s()
        self.first_rtp_pt: Optional[int] = None

sessions: Dict[str, Session] = {}

def post_event(evt:dict):
    try:
        # Log local además de relé
        etype = evt.get("type")
        call_id = evt.get("callId")
        speaker = evt.get("speaker")
        turn_id = evt.get("turnId")
        text = evt.get("text")
        if etype == "partial" and text and LOG_PARTIALS:
            logger.info("[partial] %s/%s %s: %s", call_id, speaker, turn_id, text)
        elif etype == "final" and text and LOG_FINALS:
            logger.info("[final] %s/%s %s: %s", call_id, speaker, turn_id, text)
        elif etype == "error":
            logger.error("[error] %s/%s: %s", call_id, speaker, evt.get("error"))

        requests.post(RELAY_URL, json=evt, timeout=0.4)
    except Exception:
        pass

@app.get("/health")
def health(): 
    return PlainTextResponse("ok")

@app.websocket("/stream")
async def stream(ws: WebSocket):
    await ws.accept()
    # Query: ?callId=...&speaker=customer|agent|mix
    qs = {}
    if ws.url and ws.url.query:
        for p in ws.url.query.split("&"):
            if not p: 
                continue
            k, _, v = p.partition("=")
            qs[k] = v
    call_id = qs.get("callId","unknown")
    speaker = qs.get("speaker","mix")
    sid = f"{call_id}:{speaker}"
    sess = sessions.get(sid) or Session(call_id, speaker)
    sessions[sid] = sess
    logger.info("Conexión WS abierta: callId=%s speaker=%s", call_id, speaker)

    # Tamaños para VAD 20ms @16k
    vad_frame_ms = 20
    vad_frame_samples = int(SAMPLE_RATE * vad_frame_ms / 1000)

    try:
        while True:
            raw = await ws.receive_bytes()
            if not raw:
                continue

            # Decodifica payload
            local_sr_in = SAMPLE_RATE_IN
            if is_rtp(raw):
                payload, pt = parse_rtp(raw)
                if not payload:
                    continue
                if pt in (0, 8):
                    # G.711 PCMU(0)/PCMA(8) @ 8 kHz
                    frame = decode_g711_ulaw(payload) if pt == 0 else decode_g711_alaw(payload)
                    local_sr_in = 8000
                else:
                    # Intento de PCM16LE si longitud par
                    if len(payload) % 2 != 0:
                        payload = payload[:-1]
                    frame = np.frombuffer(payload, dtype="<i2")
                    # Primer encuentro de PT desconocido: log asunción
                    if sess.first_rtp_pt is None:
                        logger.info("RTP detectado %s/%s payload=PT%d (asumiendo PCM16LE)", call_id, speaker, pt if pt is not None else -1)
                # Log del tipo de payload RTP (primera vez)
                if sess.first_rtp_pt is None and pt is not None:
                    sess.first_rtp_pt = int(pt)
                    kind = "PCMU" if pt == 0 else ("PCMA" if pt == 8 else f"PT{pt}")
                    logger.info("RTP detectado %s/%s payload=%s (pt=%d)", call_id, speaker, kind, pt)
            else:
                # Raw PCM16 mono LE
                if len(raw) % 2 != 0:
                    raw = raw[:-1]
                frame = np.frombuffer(raw, dtype="<i2")

            # Normaliza SR a 16k
            if local_sr_in == 8000:
                frame = resample_8k_to_16k(frame)
            elif local_sr_in != 16000:
                # si llega otra SR, lo aceptamos como 16k para no romper (mejorar con resampler real)
                pass

            # push ring buffer
            sess.rb.push(frame)

            # Energía + VAD 20ms
            energy = float(np.mean(np.abs(frame))) if frame.size else 0.0
            is_voice_energy = energy > ENERGY_THRESH

            # VAD: evaluamos bloques de 20ms exactos al final
            tail = sess.rb.tail(vad_frame_samples)
            is_voice_vad = False
            if tail.size == vad_frame_samples:
                is_voice_vad = vad.is_speech(tail.tobytes(), SAMPLE_RATE)

            is_voice = is_voice_energy or is_voice_vad

            # Métricas de flujo de audio (ventana)
            sess.win_frames += 1
            sess.win_samples += int(frame.size)
            sess.win_bytes += int(len(raw))
            sess.last_energy = energy
            sess.last_vad = bool(is_voice_vad)
            if FRAME_LOG_SEC > 0 and (now_s() - sess.last_log) >= FRAME_LOG_SEC:
                rb_secs = sess.rb.filled / float(SAMPLE_RATE)
                logger.info(
                    "[audio] %s/%s frames=%d samples=%d secs=%.2f bytes=%d rms=%.1f vad=%s rb=%.2fs open=%s",
                    call_id, speaker,
                    sess.win_frames, sess.win_samples, sess.win_samples/float(SAMPLE_RATE), sess.win_bytes,
                    sess.last_energy, sess.last_vad, rb_secs, bool(sess.open_turn)
                )
                sess.win_frames = 0
                sess.win_samples = 0
                sess.win_bytes = 0
                sess.last_log = now_s()

            if is_voice:
                sess.last_voice = now_s()
                if sess.open_turn is None:
                    sess.turn_idx += 1
                    sess.open_turn = f"t-{sess.turn_idx}"

            # Parciales (sliding window) — opcionalmente sólo si hay voz reciente
            if (now_s() - sess.last_emit) > DECODE_INTERVAL and sess.rb.filled > int(SAMPLE_RATE * MIN_DECODE_S):
                if (not PARTIAL_REQUIRE_VOICE) or is_voice or ((now_s() - sess.last_voice) * 1000 <= PARTIAL_RECENT_VOICE_MS):
                    async with sess.lock:
                        chunk = sess.rb.tail(int(SAMPLE_RATE * SLIDING_S)).astype(np.float32) / 32768.0
                        segs, info = model.transcribe(
                            chunk, language=LANG, beam_size=2, temperature=0.0,
                            condition_on_previous_text=False,
                            initial_prompt=None,
                            vad_filter=True, vad_parameters=dict(
                                threshold=0.5, min_silence_duration_ms=250
                            ), word_timestamps=False
                        )
                        text = "".join(s.text for s in segs).strip()
                        sess.last_emit = now_s()
                    if text:
                        post_event({
                            "type":"partial","callId":call_id,"speaker":speaker,
                            "turnId": sess.open_turn or f"t-{sess.turn_idx or 1}",
                            "text": normalize_es(text)
                        })

            # Endpoint por silencio
            if sess.open_turn and ((now_s() - sess.last_voice) * 1000 > ENDPOINT_MS) and sess.rb.filled > int(SAMPLE_RATE * 0.4):
                async with sess.lock:
                    audio_f = sess.rb.all().astype(np.float32) / 32768.0
                    segs, info = model.transcribe(
                        audio_f, language=LANG, beam_size=4,
                        vad_filter=True, vad_parameters=dict(
                            threshold=0.5, min_silence_duration_ms=350),
                        word_timestamps=False
                    )
                    final = normalize_es("".join(s.text for s in segs).strip())
                if final:
                    post_event({
                        "type":"final","callId":call_id,"speaker":speaker,
                        "turnId": sess.open_turn, "text": final
                    })
                    sess.ctx_text = (sess.ctx_text + " " + final)[-CTX_LIMIT_CHARS:]
                    # reset turno/buffer solo si hubo texto final
                    sess.rb = RingBuffer(int(SAMPLE_RATE * RING_SEC_MAX))
                    sess.open_turn = None
                else:
                    logger.debug("[final vacío] %s/%s turno=%s; manteniendo buffer para más audio",
                                 call_id, speaker, sess.open_turn)
                sess.last_emit = now_s()

    except WebSocketDisconnect:
        logger.info("Conexión WS cerrada: callId=%s speaker=%s", call_id, speaker)
    except Exception as e:
        # error no fatal por sesión
        post_event({"type":"error","callId":call_id,"speaker":speaker,"error":str(e)})
    finally:
        # cleanup opcional (mantén si quieres continuidad por reconexión)
        # sessions.pop(sid, None)
        try:
            await ws.close()
        except Exception:
            pass

if __name__ == "__main__":
    # ws_max_size aumentado por si llegan frames grandes
    uvicorn.run(app, host="0.0.0.0", port=8080, ws_max_size=4_000_000)
