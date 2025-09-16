# Relay WebSocket - Coach de Llamadas

El Relay WebSocket es el componente central de comunicación del sistema de coach de llamadas. Actúa como un hub que distribuye eventos entre todos los componentes del sistema.

## 🎯 Funcionalidad

El relay recibe eventos de transcripción y coaching de múltiples fuentes y los distribuye a todos los clientes suscritos a una llamada específica.

## 🏗️ Arquitectura

### Endpoints

- **`GET /health`**: Health check del servicio
- **`POST /event`**: Recibe eventos de STT y LLM
- **`WS /ws?callId=<id>`**: WebSocket para suscripción a eventos

### Flujo de Datos

1. **STT Server** → `POST /event` → Relay
2. **Orquestador LLM** → `POST /event` → Relay  
3. **Relay** → `WS /ws?callId=<id>` → Frontend
4. **Relay** → `WS /ws?callId=<id>` → Orquestador

## 📡 Tipos de Eventos

### Eventos de Transcripción (STT)

```json
{
  "type": "partial",
  "callId": "abc123",
  "speaker": "customer|agent|mix",
  "turnId": "t-1",
  "text": "Hola, buenos días...",
  "tsStart": 1640995200000,
  "tsEnd": 1640995201000
}
```

```json
{
  "type": "final", 
  "callId": "abc123",
  "speaker": "customer",
  "turnId": "t-1",
  "text": "Hola, buenos días, me gustaría información sobre sus productos",
  "tsStart": 1640995200000,
  "tsEnd": 1640995202000
}
```

### Eventos de Coaching (LLM)

```json
{
  "type": "coach",
  "callId": "abc123", 
  "mode": "tip|alert",
  "severity": "low|med|high",
  "text": "Sugerencia: Pregunta sobre sus necesidades específicas",
  "turnRef": "t-1"
}
```

## 🚀 Instalación y Uso

### Dependencias

```bash
npm install express ws
```

### Variables de Entorno

```bash
PORT=7070  # Puerto del servidor (opcional, default: 7070)
```

### Ejecución

```bash
node relay.js
```

### Con systemd

```bash
# Copiar archivo de servicio
sudo cp relay.service /etc/systemd/system/

# Habilitar y iniciar
sudo systemctl enable relay.service
sudo systemctl start relay.service

# Ver logs
sudo journalctl -u relay.service -f
```

## 🔧 Configuración

### Límites

- **Backlog máximo**: 50 eventos por callId
- **Payload máximo**: 1MB por request
- **Conexiones**: Ilimitadas por callId

### Gestión de Memoria

- Los eventos antiguos se eliminan automáticamente del backlog
- Las rooms se limpian cuando no hay conexiones activas
- Manejo robusto de errores en WebSocket

## 📊 Monitoreo

### Health Check

```bash
curl http://localhost:7070/health
# Respuesta: ok
```

### Logs

El relay registra:
- Inicio del servidor con puerto y endpoints
- Conexiones WebSocket (implícito)
- Errores de conexión

### Métricas

- **Conexiones activas**: `rooms.size`
- **Eventos en backlog**: `backlog.size`
- **Eventos por callId**: `backlog.get(callId)?.length`

## 🔗 Integración

### Con STT Server

```javascript
// STT envía eventos al relay
fetch('http://localhost:7070/event', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    type: 'partial',
    callId: 'abc123',
    speaker: 'customer',
    text: 'Hola...'
  })
});
```

### Con Frontend

```javascript
// Frontend se conecta al relay
const ws = new WebSocket('ws://localhost:7070/ws?callId=abc123');
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  // Procesar evento de transcripción o coaching
};
```

### Con Orquestador LLM

```javascript
// Orquestador se conecta al relay
const ws = new WebSocket('ws://localhost:7070/ws?callId=live');
ws.onmessage = (event) => {
  const data = JSON.parse(event.data);
  if (data.type === 'final') {
    // Procesar transcripción y generar coaching
  }
};
```

## 🛠️ Troubleshooting

### Problemas Comunes

1. **Puerto ocupado**: Cambiar PORT en variables de entorno
2. **Conexiones rechazadas**: Verificar que el servidor esté ejecutándose
3. **Eventos no llegan**: Verificar que el callId sea correcto

### Debug

```bash
# Ver conexiones activas
netstat -an | grep 7070

# Probar endpoint de eventos
curl -X POST http://localhost:7070/event \
  -H "Content-Type: application/json" \
  -d '{"callId":"test","type":"test","text":"test"}'
```

## 📝 Notas Técnicas

- **Protocolo**: HTTP/1.1 + WebSocket
- **Formato**: JSON
- **Encoding**: UTF-8
- **Timeout**: Sin timeout (conexiones persistentes)
- **Reconexión**: Los clientes deben implementar reconexión automática


## verificar funcionamiento

  npx wscat -c 'ws://127.0.0.1:7070/ws?callId='
