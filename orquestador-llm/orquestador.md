# Orquestador LLM - Coach de Llamadas

El orquestador LLM es el componente encargado de procesar las transcripciones de las llamadas y generar consejos de coaching en tiempo real utilizando modelos de lenguaje a través de OpenRouter.

## 🚀 Instalación y Configuración

### Dependencias

```bash
npm i ws node-fetch dotenv
```

### Variables de Entorno

Crea un archivo `.env` con las siguientes variables:

```env
# API de OpenRouter
OPENROUTER_API_KEY=sk-or-xxxx
OPENROUTER_MODEL=anthropic/claude-3.5-sonnet

# Configuración del Relay
RELAY_WS=ws://127.0.0.1:7070/ws?callId=live
RELAY_EVENT=http://127.0.0.1:7070/event

# Configuración de la aplicación
APP_TITLE=Coach de Llamadas
STREAM=true                 # "true" para streaming SSE
TEMP=0.2                    # baja = más estable
MAX_TOKENS=300              # control de coste/latencia
```

## 🏃‍♂️ Ejecución

```bash
node orquestador-openrouter.js
```

## 🔧 Funcionamiento

### Flujo de Trabajo

1. **Conexión WebSocket**: Se conecta al Relay WebSocket para recibir eventos de transcripción
2. **Procesamiento**: Cuando recibe un evento `final` (transcripción completa), procesa el texto
3. **Generación de Consejos**: Utiliza OpenRouter para generar consejos de coaching
4. **Envío de Respuesta**: Envía el consejo de vuelta al Relay para que llegue al frontend

### Características Principales

- **Redacción de PII**: Automáticamente redacta información personal identificable (emails, etc.)
- **Contexto Acumulativo**: Mantiene historial de la conversación para mejor contexto
- **Detección de Alertas**: Identifica objeciones o riesgos y genera alertas
- **Múltiples Modos**: Genera tips de conversación, próximas acciones y alertas
- **Manejo de Errores**: Respuestas de fallback en caso de errores del LLM

### Tipos de Respuesta

- **`tip`**: Consejos generales de conversación (claridad, empatía, descubrimiento)
- **`alert`**: Alertas cuando detecta objeciones o riesgos
- **`coach`**: Próximas acciones sugeridas (CTA)

## 📋 Configuración del Sistema

### Modelos Soportados

- `anthropic/claude-3.5-sonnet` (recomendado)
- `openai/gpt-4o-mini`
- `meta/llama-3.1-70b-instruct`
- Otros modelos disponibles en OpenRouter

### Parámetros de Configuración

- **`TEMP`**: Controla la creatividad (0.1-1.0, menor = más estable)
- **`MAX_TOKENS`**: Limita la longitud de respuesta (control de costos)
- **`STREAM`**: Habilita streaming para respuestas más rápidas

## 🔗 Integración

El orquestador se integra con:

- **Relay WebSocket**: Para recibir transcripciones y enviar consejos
- **OpenRouter API**: Para acceso a modelos de lenguaje
- **Sistema de Archivos**: Para logging y persistencia de historial

## 🛠 Troubleshooting

### Problemas Comunes

1. **Error de conexión WebSocket**: Verificar que el Relay esté ejecutándose
2. **Error de API**: Verificar la clave de OpenRouter y límites de uso
3. **Respuestas vacías**: Revisar configuración de `MAX_TOKENS` y `TEMP`

### Logs

El orquestador registra:
- Conexiones WebSocket
- Errores de API
- Respuestas generadas
- Eventos de transcripción procesados
