import os, time, json, numpy as np, webrtcvad, requests
from typing import Dict
from faster_whisper import WhisperModel
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import PlainTextResponse
import uvicorn

# --- Config ---
LANG            = os.getenv("LANG","es")
MODEL_SIZE      = os.getenv("MODEL_SIZE","small")       # small|medium (GPU 8-12GB -> medium)
DEVICE          = os.getenv("DEVICE","cpu")             # cuda|cpu
COMPUTE_TYPE    = os.getenv("COMPUTE_TYPE","int8")      # float16 en GPU
SAMPLE_RATE     = int(os.getenv("SAMPLE_RATE","16000"))
DECODE_INTERVAL = float(os.getenv("DECODE_INTERVAL","0.2"))     # s
SLIDING_S       = float(os.getenv("SLIDING_S","1.0"))           # s
MIN_DECODE_S    = float(os.getenv("MIN_DECODE_S","0.6"))        # s
ENDPOINT_MS     = int(os.getenv("ENDPOINT_MS","450"))           # ms
RELAY_URL       = os.getenv("RELAY_URL","http://127.0.0.1:7070/event")
ENERGY_THRESH   = int(os.getenv("ENERGY_THRESH","400"))         # ajusta a tu nivel RMS

print(f"Loading faster-whisper {MODEL_SIZE} on {DEVICE}/{COMPUTE_TYPE}...")
# en server.py, donde haces WhisperModel(...):
MODEL_PATH = os.getenv("MODEL_PATH", "/opt/asterisk-stt/models/faster-whisper-small")
model = WhisperModel(MODEL_PATH, device=DEVICE, compute_type=COMPUTE_TYPE)

# model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)

app = FastAPI()
vad = webrtcvad.Vad(2)  # 0-3 (3 es más agresivo)

class Session:
    def __init__(self, call_id:str, speaker:str):
        self.call_id = call_id
        self.speaker = speaker
        self.buf = np.zeros(0, dtype=np.int16)
        self.last_emit = 0.0
        self.last_voice = time.time()
        self.turn_idx = 0
        self.open_turn = None  # turnId actual
        self.ctx_text = ""     # contexto acumulado (mejora estabilidad)

sessions: Dict[str, Session] = {}

def post_event(evt:dict):
    try:
        requests.post(RELAY_URL, json=evt, timeout=0.5)
    except Exception:
        pass

def now_s(): return time.time()

@app.get("/health")
def health(): return PlainTextResponse("ok")

@app.websocket("/stream")
async def stream(ws: WebSocket):
    # Query: ?callId=...&speaker=customer|agent|mix
    await ws.accept()
    qs = dict([p.split('=') if '=' in p else (p,'') for p in (ws.url.query or '').split('&') if p])
    call_id = qs.get('callId','unknown')
    speaker = qs.get('speaker','mix')
    sid = f"{call_id}:{speaker}"
    sess = sessions.get(sid) or Session(call_id, speaker)
    sessions[sid] = sess

    try:
        while True:
            raw = await ws.receive_bytes()
            if len(raw) <= 12:  # si viene con RTP header por error
                continue
            if len(raw) % 2 != 0:  # debe ser PCM16
                continue

            frame = np.frombuffer(raw, dtype="<i2")
            sess.buf = np.concatenate((sess.buf, frame))[-SAMPLE_RATE*3:]  # 3s máx

            # VAD + energía
            # WebRTC VAD requiere 10/20/30ms 16-bit mono; usamos 20ms típico (320 muestras)
            energy = int(np.mean(np.abs(frame)))
            is_voice = energy > ENERGY_THRESH
            # (opcional) refinar con webrtcvad: dividir en tramas de 20ms exactas
            # omitimos por simplicidad y uso de ENERGY_THRESH

            if is_voice:
                sess.last_voice = now_s()
                if sess.open_turn is None:
                    sess.turn_idx += 1
                    sess.open_turn = f"t-{sess.turn_idx}"
                    # puedes enviar un "start-turn" si quieres

            # Parciales
            if (now_s() - sess.last_emit) > DECODE_INTERVAL and len(sess.buf) > SAMPLE_RATE*MIN_DECODE_S:
                chunk = sess.buf[-int(SAMPLE_RATE*SLIDING_S):].astype(np.float32)/32768.0
                segs, info = model.transcribe(
                    chunk, language=LANG, beam_size=1,
                    condition_on_previous_text=True, initial_prompt=sess.ctx_text or None,
                    vad_filter=False, word_timestamps=False
                )
                text = "".join([s.text for s in segs]).strip()
                sess.last_emit = now_s()
                if text:
                    post_event({
                        "type":"partial","callId":call_id,"speaker":speaker,
                        "turnId": sess.open_turn or f"t-{sess.turn_idx or 1}",
                        "text": normalize_es(text)
                    })

            # Endpoint por silencio
            if sess.open_turn and (now_s() - sess.last_voice)*1000 > ENDPOINT_MS and len(sess.buf) > SAMPLE_RATE*0.4:
                audio_f = sess.buf.astype(np.float32)/32768.0
                segs, info = model.transcribe(
                    audio_f, language=LANG, beam_size=4,
                    vad_filter=True, vad_parameters=dict(
                        threshold=0.5, min_silence_duration_ms=350),
                    word_timestamps=False
                )
                final = normalize_es("".join([s.text for s in segs]).strip())
                if final:
                    post_event({
                        "type":"final","callId":call_id,"speaker":speaker,
                        "turnId": sess.open_turn, "text": final
                    })
                    # actualizar contexto para próximas decodificaciones
                    sess.ctx_text = (sess.ctx_text + " " + final)[-2000:]  # limita memoria
                # reset turno/buffer
                sess.buf = np.zeros(0, dtype=np.int16)
                sess.open_turn = None
                sess.last_emit = now_s()
    except WebSocketDisconnect:
        pass

def normalize_es(text:str)->str:
    """
    Normalización ligera para español telefónico:
    - espacios y puntuación
    - números telefónicos (opcional: deja como dictado)
    - minúsculas salvo acrónimos simples (opcional)
    """
    t = text.replace(" ,", ",").replace(" .", ".").replace(" !","!").replace(" ?","?")
    t = t.strip()
    # ejemplos de normalización opcional:
    # t = re.sub(r"\buno\b(?=\s+[0-9])","1", t)  # si quieres número
    return t

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8080, ws_max_size=4_000_000)
