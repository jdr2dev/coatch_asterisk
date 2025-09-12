# 📞 Asistente de Llamadas con Asterisk + ARI + STT + LLM

Este sistema permite capturar llamadas en **Asterisk**, transcribirlas en vivo con **Whisper on-prem**, enviar el texto a un **LLM (OpenRouter)** y mostrar en un **Frontend** transcripción + coaching en tiempo real.

---

## ⚙️ Componentes principales

### 1. Asterisk (PBX)
- **Rol**: Manejo de llamadas, puente de medios.
- **Servicios**: `asterisk`
- **Puertos**:
  - SIP/RTP (según `pjsip.conf`)
  - **8088/TCP** → ARI
  - **10000–20000/UDP** → RTP
- **Ficheros clave**:
  - `/etc/asterisk/http.conf` (ARI on)
  - `/etc/asterisk/ari.conf` (user `coach`)
  - `/etc/asterisk/rtp.conf`
  - `/etc/asterisk/pjsip.conf`
  - `/etc/asterisk/extensions.conf`  
    - entrante → `Stasis(coach_app,role=caller,...)`
    - `MixMonitor(...,bm)` para grabación estéreo

---

### 2. App ARI (Node.js)
- **Servicio**: `ari-coach.service`
- **Fichero**: `/opt/ari/ari-coach-app.js`
- **Rol**:  
  - Maneja `StasisStart`
  - Crea **bridge**, origina **agente**
  - Activa **ExternalMedia** (mix/customer/agent)
  - Lanza **rtp2ws** por llamada
- **Vars**: `ARI_URL`, `ARI_USER`, `ARI_PASS`, `BASE_PORT=14000`, `AGENT_DIAL`

---

### 3. STT Server (Whisper on-prem)
- **Servicio**: `stt.service`
- **Fichero**: `/opt/asterisk-stt/stt/server.py`
- **Puerto**: **8080/TCP**
  - `GET /health`
  - `WS /stream?callId=...&speaker=...`
- **Modelo**: `/opt/asterisk-stt/models/faster-whisper-small/*`
- **Vars**:
  - `MODEL_PATH=/opt/asterisk-stt/models/faster-whisper-small`
  - `HF_HUB_ENABLE_HF_TRANSFER=0`

---

### 4. RTP → WS por llamada (Node.js)
- **Proceso**: lanzado por la App ARI
- **Script**: `/opt/asterisk-stt/rtp2ws/call-rtp2ws.js`
- **Rol**:  
  - Escucha UDP (3 puertos por llamada: mix/customer/agent)  
  - Envía audio PCM16 al STT por WebSocket

---

### 5. Relay WebSocket
- **Servicio**: `relay.service`
- **Fichero**: `/opt/relay/relay.js`
- **Puerto**: **7070/TCP**
- **Rol**:  
  - `POST /event` → recibe `partial/final/coach` de STT y LLM  
  - `WS /ws?callId=...` → entrega eventos a **Frontend** y **Orquestador**

---

### 6. Orquestador LLM (OpenRouter)
- **Servicio**: `orchestrator.service`
- **Fichero**: `/opt/orchestrator/orquestador-openrouter.js`
- **Rol**:  
  - Suscrito al Relay WS  
  - Al recibir `final`, arma prompt y consulta **OpenRouter**  
  - Devuelve `coach/tip/alert` al Relay
- **Vars**:
  - `OPENROUTER_API_KEY=sk-or-xxxx`
  - `OPENROUTER_MODEL=anthropic/claude-3.5-sonnet`
  - `RELAY_WS=ws://127.0.0.1:7070/ws?callId=live`
  - `RELAY_EVENT=http://127.0.0.1:7070/event`

---

### 7. Frontend (UI agente)
- **Servicio**: web server (Nginx o Vite dev)
- **Rol**:  
  - Conexión a `ws://<relay>:7070/ws?callId=...`  
  - Muestra transcripciones y tips en tiempo real

---

## 🔄 Orden de arranque recomendado

1. `asterisk`
2. `stt.service`
3. `relay.service`
4. `orchestrator.service`
5. `ari-coach.service`
6. Frontend

---

## 🛠 Systemd Units (ejemplo)

### `stt.service`
```ini
[Unit]
Description=Whisper STT (FastAPI)
After=network-online.target

[Service]
WorkingDirectory=/opt/asterisk-stt/stt
ExecStart=/opt/asterisk-stt/venv/bin/python /opt/asterisk-stt/stt/server.py
Restart=always
Environment=MODEL_PATH=/opt/asterisk-stt/models/faster-whisper-small
Environment=HF_HUB_ENABLE_HF_TRANSFER=0

[Install]
WantedBy=multi-user.target
