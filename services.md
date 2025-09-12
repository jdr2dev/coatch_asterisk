# Servicios Systemd - Coach de Llamadas

Este documento contiene las configuraciones de servicios systemd necesarias para el sistema de coach de llamadas con Asterisk, STT y LLM.

## 📋 Servicios Incluidos

- **stt.service**: Servidor de transcripción Whisper on-prem
- **rtp2ws.service**: Conversor de RTP a WebSocket
- **relay.service**: Relay WebSocket para comunicación entre componentes
- **orchestrator.service**: Orquestador LLM para coaching
- **ari-coach.service**: Aplicación ARI para manejo de llamadas

---

## 🎤 Servicio STT (stt.service)

**Archivo**: `/etc/systemd/system/stt.service`

```ini
[Unit]
Description=Whisper STT (WS) On-Prem
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=asterisk
Group=asterisk
WorkingDirectory=/opt/asterisk-stt/stt
Environment=LANG=es
Environment=MODEL_SIZE=small
Environment=DEVICE=cpu
Environment=COMPUTE_TYPE=int8
Environment=RELAY_URL=http://127.0.0.1:7070/event
ExecStart=/opt/asterisk-stt/venv/bin/python /opt/asterisk-stt/stt/server.py
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
```

### Características

- **Puerto**: 8080/TCP
- **Modelo**: Whisper small (optimizado para CPU)
- **Usuario**: asterisk
- **Dependencias**: network-online.target
- **Reinicio**: Automático en caso de fallo

---

## 🔄 Servicio RTP2WS (rtp2ws.service)

**Archivo**: `/etc/systemd/system/rtp2ws.service`

```ini
[Unit]
Description=RTP L16 → WS (mix/agent/customer)
After=stt.service
Requires=stt.service

[Service]
Type=simple
User=asterisk
Group=asterisk
WorkingDirectory=/opt/asterisk-stt/rtp2ws
Environment=CALL_ID=live
ExecStart=/usr/bin/node /opt/asterisk-stt/rtp2ws/rtp2ws.js
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
```

### Características

- **Dependencia**: stt.service (requerido)
- **Función**: Convierte audio RTP a WebSocket
- **Canales**: mix, agent, customer
- **Usuario**: asterisk

---

## 🌐 Servicio Relay (relay.service)

**Archivo**: `/etc/systemd/system/relay.service`

```ini
[Unit]
Description=Relay WebSocket para Coach de Llamadas
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=asterisk
Group=asterisk
WorkingDirectory=/opt/relay
ExecStart=/usr/bin/node /opt/relay/relay.js
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
```

### Características

- **Puerto**: 7070/TCP
- **Función**: Relay de eventos entre componentes
- **Endpoints**: 
  - `POST /event` - Recibe eventos de STT y LLM
  - `WS /ws?callId=...` - Entrega eventos al Frontend

---

## 🤖 Servicio Orquestador (orchestrator.service)

**Archivo**: `/etc/systemd/system/orchestrator.service`

```ini
[Unit]
Description=Orquestador LLM para Coaching
After=relay.service
Requires=relay.service

[Service]
Type=simple
User=asterisk
Group=asterisk
WorkingDirectory=/opt/orchestrator
Environment=OPENROUTER_API_KEY=sk-or-xxxx
Environment=OPENROUTER_MODEL=anthropic/claude-3.5-sonnet
Environment=RELAY_WS=ws://127.0.0.1:7070/ws?callId=live
Environment=RELAY_EVENT=http://127.0.0.1:7070/event
ExecStart=/usr/bin/node /opt/orchestrator/orquestador-openrouter.js
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
```

### Características

- **Dependencia**: relay.service
- **Función**: Genera consejos de coaching con LLM
- **API**: OpenRouter
- **Modelo**: Claude 3.5 Sonnet (configurable)

---

## 📞 Servicio ARI Coach (ari-coach.service)

**Archivo**: `/etc/systemd/system/ari-coach.service`

```ini
[Unit]
Description=ARI Coach App para Asterisk
After=asterisk.service
Requires=asterisk.service

[Service]
Type=simple
User=asterisk
Group=asterisk
WorkingDirectory=/opt/ari
Environment=ARI_URL=http://localhost:8088/ari
Environment=ARI_USER=coach
Environment=ARI_PASS=verysecret
Environment=BASE_PORT=14000
Environment=AGENT_DIAL=PJSIP/200
ExecStart=/usr/bin/node /opt/ari/coach.js
Restart=always
RestartSec=1

[Install]
WantedBy=multi-user.target
```

### Características

- **Dependencia**: asterisk.service
- **Función**: Maneja llamadas a través de ARI
- **Puerto ARI**: 8088/TCP
- **Configuración**: Variables de entorno para conexión

---

## 🚀 Instalación y Configuración

### 1. Crear los archivos de servicio

```bash
# Crear directorios
sudo mkdir -p /opt/asterisk-stt/stt
sudo mkdir -p /opt/asterisk-stt/rtp2ws
sudo mkdir -p /opt/relay
sudo mkdir -p /opt/orchestrator
sudo mkdir -p /opt/ari

# Copiar archivos de servicio
sudo cp stt.service /etc/systemd/system/
sudo cp rtp2ws.service /etc/systemd/system/
sudo cp relay.service /etc/systemd/system/
sudo cp orchestrator.service /etc/systemd/system/
sudo cp ari-coach.service /etc/systemd/system/
```

### 2. Recargar y habilitar servicios

```bash
# Recargar configuración de systemd
sudo systemctl daemon-reload

# Habilitar servicios
sudo systemctl enable stt.service
sudo systemctl enable rtp2ws.service
sudo systemctl enable relay.service
sudo systemctl enable orchestrator.service
sudo systemctl enable ari-coach.service

# Iniciar servicios
sudo systemctl start stt.service
sudo systemctl start rtp2ws.service
sudo systemctl start relay.service
sudo systemctl start orchestrator.service
sudo systemctl start ari-coach.service
```

### 3. Verificar estado

```bash
# Verificar estado de todos los servicios
systemctl status stt.service rtp2ws.service relay.service orchestrator.service ari-coach.service

# Ver logs en tiempo real
sudo journalctl -u stt.service -f
sudo journalctl -u relay.service -f
sudo journalctl -u orchestrator.service -f
```

---

## 🔄 Orden de Arranque

Los servicios deben iniciarse en el siguiente orden:

1. **asterisk.service** (sistema base)
2. **stt.service** (servidor de transcripción)
3. **relay.service** (relay de eventos)
4. **orchestrator.service** (orquestador LLM)
5. **ari-coach.service** (aplicación ARI)
6. **rtp2ws.service** (conversor RTP, se inicia por llamada)

---

## 🛠️ Comandos de Gestión

### Iniciar/Parar servicios

```bash
# Iniciar un servicio
sudo systemctl start servicio.service

# Parar un servicio
sudo systemctl stop servicio.service

# Reiniciar un servicio
sudo systemctl restart servicio.service

# Recargar configuración
sudo systemctl reload servicio.service
```

### Ver logs

```bash
# Logs de un servicio específico
sudo journalctl -u servicio.service

# Logs en tiempo real
sudo journalctl -u servicio.service -f

# Logs de los últimos 100 mensajes
sudo journalctl -u servicio.service -n 100
```

### Verificar dependencias

```bash
# Ver dependencias de un servicio
systemctl list-dependencies servicio.service

# Ver qué servicios dependen de uno específico
systemctl list-dependencies --reverse servicio.service
```

---

## ⚠️ Notas Importantes

- **Permisos**: Todos los servicios ejecutan como usuario `asterisk`
- **Puertos**: Asegúrate de que los puertos estén disponibles (8080, 7070, 8088)
- **Dependencias**: Respeta el orden de arranque para evitar errores
- **Logs**: Revisa los logs si algún servicio no inicia correctamente
- **Configuración**: Ajusta las variables de entorno según tu entorno