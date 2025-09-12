// orquestador-openrouter.js
import WebSocket from "ws";
import fetch from "node-fetch";
import dotenv from "dotenv";
dotenv.config();

const {
  OPENROUTER_API_KEY,
  OPENROUTER_MODEL = "anthropic/claude-3.5-sonnet",
  RELAY_WS = "ws://127.0.0.1:7070/ws?callId=live",
  RELAY_EVENT = "http://127.0.0.1:7070/event",
  APP_TITLE = "Coach de Llamadas",
  STREAM = "true",
  TEMP = "0.2",
  MAX_TOKENS = "300",
} = process.env;

if (!OPENROUTER_API_KEY) {
  console.error("Falta OPENROUTER_API_KEY");
  process.exit(1);
}

// Memoria corta por llamada (solo lo necesario)
const mem = new Map(); // callId -> {history: [{speaker,text}], lastTips:[]}

function pushHistory(callId, speaker, text) {
  if (!mem.has(callId)) mem.set(callId, { history: [], lastTips: [] });
  const st = mem.get(callId);
  // mantiene solo últimos N turnos (p.ej. 12)
  st.history.push({ speaker, text });
  if (st.history.length > 12) st.history = st.history.slice(-12);
  return st;
}

async function sendRelay(evt) {
  await fetch(RELAY_EVENT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(evt),
  });
}

// Redacta PII básica (ajústalo a tu negocio)
function redactPII(text) {
  return text
    .replace(/\b\d{16}\b/g, "[CARD]")          // tarjeta simple
    .replace(/\b[ES]{0,2}\d{20,24}\b/gi, "[IBAN]")
    .replace(/\b\d{8}[A-Z]\b/gi, "[DNI]")
    .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, "[EMAIL]");
}

function buildMessages(callId) {
  const st = mem.get(callId) || { history: [] };
  const recent = st.history.map(h => `[${h.speaker}] ${redactPII(h.text)}`).join("\n");
  const system = [
    "Eres un coach de llamadas de ventas/soporte.",
    "Responde EN ESPAÑOL, conciso (máx 2 frases).",
    "Da tips accionables, no repitas al cliente.",
    "Si faltan datos, sugiere la siguiente pregunta.",
    "No incluyas PII ni datos sensibles en tu respuesta.",
  ].join(" ");

  const user = [
    "Contexto (últimos turnos):",
    recent || "(sin contexto)",
    "",
    "Tareas:",
    "- 1 tip de conversación (claridad/empatía/descubrimiento).",
    "- 1 próxima acción (CTA) si aplica.",
    "- Si detectas objeción o riesgo, di ALERTA: <motivo>.",
  ].join("\n");

  return [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
}

async function callOpenRouter(messages, { stream = true } = {}) {
  const body = {
    model: OPENROUTER_MODEL,
    temperature: Number(TEMP),
    max_tokens: Number(MAX_TOKENS),
    messages,
    stream,
  };

  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
    // Opcionales (buenas prácticas OpenRouter)
    "HTTP-Referer": "https://tu-dominio-o-ip.local", // si tienes
    "X-Title": APP_TITLE,
  };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`OpenRouter ${res.status}: ${t.slice(0, 400)}`);
  }

  if (!stream) {
    const json = await res.json();
    return json.choices?.[0]?.message?.content?.trim() || "";
  }

  // Streaming SSE (event: message con delta)
  let acc = "";
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = decoder.decode(value, { stream: true });

    // Parse básico SSE
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("data:")) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === "[DONE]") break;

      try {
        const obj = JSON.parse(payload);
        const delta = obj.choices?.[0]?.delta?.content || "";
        if (delta) acc += delta;
      } catch {}
    }
  }
  return acc.trim();
}

// Suscripción al Relay
const ws = new WebSocket(RELAY_WS);
ws.on("open", () => console.log("Orquestador conectado al Relay WS"));

ws.on("message", async (m) => {
  const evt = JSON.parse(m);

  // Procesa turnos cerrados (final). Puedes añadir lógica para partial cada X s.
  if (evt.type === "final") {
    const callId = evt.callId || "live";
    pushHistory(callId, evt.speaker || "unknown", evt.text || "");

    try {
      const messages = buildMessages(callId);
      const reply = await callOpenRouter(messages, { stream: (String(STREAM) === "true") });

      if (reply) {
        await sendRelay({
          type: "coach",
          callId,
          turnRef: evt.turnId,
          mode: reply.toLowerCase().includes("alerta") ? "alert" : "tip",
          severity: "med",
          text: reply,
        });
      }
    } catch (e) {
      console.error("LLM error:", e.message);
      await sendRelay({
        type: "coach",
        callId,
        turnRef: evt.turnId,
        mode: "alert",
        severity: "low",
        text: "No pude generar consejo ahora. Continuad con el guion de descubrimiento.",
      });
    }
  }
});
