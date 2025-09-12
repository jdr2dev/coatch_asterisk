# EchoCoach - Frontend de Live Coaching

Frontend de la aplicación de coach de llamadas en tiempo real construido con React, TypeScript y Vite. Esta aplicación proporciona una interfaz de usuario para que los agentes de ventas/soporte reciban consejos de coaching en tiempo real durante las llamadas.

## 🎯 Características Principales

- **Live Coaching en Tiempo Real**: Recibe consejos de coaching mientras la llamada está en progreso
- **Transcripción en Vivo**: Visualiza transcripciones parciales y finales de la conversación
- **KPIs de Conversación**: Métricas de tiempo de habla entre agente y cliente
- **Alertas Inteligentes**: Notificaciones cuando se detectan objeciones o riesgos
- **Interfaz Intuitiva**: Diseño limpio y fácil de usar para agentes

## 🚀 Instalación y Configuración

### Prerrequisitos

- Node.js 18+ 
- npm o yarn
- Acceso al Relay WebSocket (puerto 7070)

### Instalación

```bash
# Instalar dependencias
npm install

# Ejecutar en modo desarrollo
npm run dev

# Construir para producción
npm run build

# Vista previa de la build
npm run preview
```

### Configuración

La aplicación se conecta al sistema de coach de llamadas a través de:

1. **Relay URL**: URL del servidor relay (ej: `ws://localhost:7070`)
2. **Call ID**: Identificador único de la llamada (UUID o linkedid de Asterisk)

#### Configuración por URL

Puedes pasar los parámetros directamente en la URL:

```
http://localhost:5173/?relayUrl=ws://localhost:7070&callId=503ee774-1234-5678-9abc-def012345678
```

#### Configuración Manual

Usa el formulario en la interfaz para configurar:
- **Relay URL**: `ws://localhost:7070` (por defecto)
- **Call ID**: UUID de la llamada activa

## 🏗️ Arquitectura

### Componentes Principales

- **`App.tsx`**: Componente principal con configuración y estado global
- **`LiveCoach.tsx`**: Componente principal que maneja la conexión WebSocket y renderiza la interfaz
- **`Bubble`**: Componente para mostrar mensajes de transcripción
- **`CoachBubble`**: Componente para mostrar consejos de coaching

### Flujo de Datos

1. **Conexión WebSocket**: Se conecta al Relay WebSocket usando `relayUrl` y `callId`
2. **Recepción de Eventos**: Recibe eventos de tipo:
   - `partial`: Transcripción parcial en tiempo real
   - `final`: Transcripción final de un turno
   - `coach`: Consejos de coaching del orquestador LLM
3. **Renderizado**: Actualiza la interfaz con transcripciones y consejos

### Tipos de Eventos

```typescript
type Speaker = 'agent' | 'customer';
type Evt = 
  | { type: 'partial' | 'final'; callId: string; speaker: Speaker; text: string; turnId: string; tsStart: number; tsEnd?: number; }
  | { type: 'coach'; callId: string; mode: 'tip' | 'alert'; severity: 'low' | 'med' | 'high'; text: string; turnRef: string; };
```

## 📊 KPIs y Métricas

La aplicación calcula automáticamente:

- **Talk/Listen Ratio**: Proporción de tiempo de habla entre agente y cliente
- **Número de Turnos**: Cantidad de intervenciones por cada participante
- **Tiempo Total**: Duración de la conversación

## 🎨 Personalización

### Estilos

Los estilos están definidos como objetos JavaScript en cada componente para facilitar la personalización.

### Configuración de Desarrollo

```bash
# Linting
npm run lint

# Type checking
npx tsc --noEmit
```

## 🔧 Desarrollo

### Estructura del Proyecto

```
src/
├── App.tsx          # Componente principal
├── LiveCoach.tsx    # Componente de coaching en vivo
├── App.css          # Estilos globales
├── index.css        # Estilos base
└── main.tsx         # Punto de entrada
```

### Scripts Disponibles

- `npm run dev`: Servidor de desarrollo con HMR
- `npm run build`: Construcción para producción
- `npm run preview`: Vista previa de la build
- `npm run lint`: Linting con ESLint

## 🌐 Integración

Esta aplicación se integra con:

- **Relay WebSocket**: Para recibir eventos de transcripción y coaching
- **Sistema Asterisk**: A través del ARI y aplicaciones de Node.js
- **Orquestador LLM**: Para recibir consejos de coaching generados por IA

## 📱 Uso

1. **Iniciar la aplicación**: `npm run dev`
2. **Configurar conexión**: Ingresar Relay URL y Call ID
3. **Iniciar llamada**: El sistema comenzará a mostrar transcripciones y consejos
4. **Monitorear KPIs**: Observar métricas de conversación en tiempo real

## 🛠️ Troubleshooting

### Problemas Comunes

1. **No se conecta al WebSocket**: Verificar que el Relay esté ejecutándose en el puerto 7070
2. **No recibe transcripciones**: Verificar que el Call ID sea correcto y la llamada esté activa
3. **No recibe consejos de coaching**: Verificar que el orquestador LLM esté funcionando

### Logs de Desarrollo

La aplicación registra en consola:
- Conexiones WebSocket
- Eventos recibidos
- Errores de conexión