// App.tsx
import React, { useEffect, useMemo, useState } from 'react';
import LiveCoach from './LiveCoatch';

type PersistKeys = {
  relayUrl: string;
  callId: string;
};

function getFromEnv(): PersistKeys {
  // Vite: import.meta.env.VITE_*
  const envRelay = (import.meta as any)?.env?.VITE_RELAY_URL as string | undefined;
  const envCallId = (import.meta as any)?.env?.VITE_DEFAULT_CALL_ID as string | undefined;
  return {
    relayUrl: envRelay ?? '',
    callId: envCallId ?? '',
  };
}

function getFromQuery(): Partial<PersistKeys> {
  try {
    const sp = new URLSearchParams(window.location.search);
    const relayUrl = sp.get('relayUrl') ?? undefined;
    const callId = sp.get('callId') ?? undefined;
    return {
      relayUrl: relayUrl && relayUrl.trim() ? relayUrl.trim() : undefined,
      callId: callId && callId.trim() ? callId.trim() : undefined,
    };
  } catch {
    return {};
  }
}

function getFromStorage(): Partial<PersistKeys> {
  try {
    const raw = localStorage.getItem('livecoach.prefs');
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return {
      relayUrl: typeof parsed?.relayUrl === 'string' ? parsed.relayUrl : undefined,
      callId: typeof parsed?.callId === 'string' ? parsed.callId : undefined,
    };
  } catch {
    return {};
  }
}

function saveToStorage(v: PersistKeys) {
  try {
    localStorage.setItem('livecoach.prefs', JSON.stringify(v));
  } catch {}
}

function normalizeRelayUrl(input: string): string {
  if (!input) return '';
  const trimmed = input.toString().trim();
  // Permite http(s) o ws(s); si pasa http(s), no lo cambiamos (puede ser reverse proxy a ws)
  // Si pasa "ws://host:port" o "wss://", también OK.
  return trimmed.replace(/\/+$/, ''); // quitar trailing slash
}

export default function App() {
  // 1) Fuente de verdad inicial: query > storage > env
  const env = getFromEnv();
  const q = getFromQuery();
  const st = getFromStorage();

  const [relayUrl, setRelayUrl] = useState<string>(
    normalizeRelayUrl(q.relayUrl ?? st.relayUrl ?? env.relayUrl ?? '')
  );
  const [callId, setCallId] = useState<string>(q.callId ?? st.callId ?? env.callId ?? '');

  // 2) Persistir cambios
  useEffect(() => {
    saveToStorage({ relayUrl, callId });
  }, [relayUrl, callId]);

  // 3) Derivar estado de validez
  const propsOk = useMemo(() => Boolean(relayUrl && callId), [relayUrl, callId]);

  // 4) Pequeña ayuda para autocompletar URL según contexto
  const suggestRelay = useMemo(() => {
    if (relayUrl) return relayUrl;
    // Sugerencia por defecto: mismo host con /relay (ajústalo a tu backend)
    const origin = window.location.origin.replace(/^http/, 'ws'); // http->ws, https->wss
    return `${origin}/relay`;
  }, [relayUrl]);

  // 5) Handlers
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setRelayUrl(normalizeRelayUrl(relayUrl));
  };

  return (
    <div style={styles.app}>
      <header style={styles.header}>
        <div style={styles.brand}>
          <strong>EchoCoach · Demo</strong>
        </div>
        <form style={styles.form} onSubmit={onSubmit}>
          <label style={styles.label}>
            Relay URL
            <input
              style={styles.input}
              type="text"
              placeholder={suggestRelay}
              value={relayUrl}
              onChange={(e) => setRelayUrl(e.target.value)}
            />
          </label>
          <label style={styles.label}>
            Call ID
            <input
              style={styles.input}
              type="text"
              placeholder="p.ej. 503ee774-... (linkedid/uuid)"
              value={callId}
              onChange={(e) => setCallId(e.target.value)}
            />
          </label>
          <button style={styles.button} type="submit">Aplicar</button>
        </form>
      </header>

      {!propsOk && (
        <div style={styles.notice}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Configuración incompleta</div>
          <div>
            Indica <code>Relay URL</code> y <code>Call ID</code> arriba. <br />
            Tip: puedes pasar <code>?relayUrl=</code> y <code>?callId=</code> en la URL.
          </div>
        </div>
      )}

      <main style={styles.main}>
        {propsOk ? (
          <LiveCoach relayUrl={relayUrl} callId={callId} />
        ) : (
          <div style={styles.placeholder}>
            <div style={{ opacity: 0.7 }}>
              Esperando configuración para iniciar el Live Coaching…
            </div>
          </div>
        )}
      </main>

      <footer style={styles.footer}>
        <small>
          Estado: {propsOk ? 'Listo' : 'Faltan datos'} ·{' '}
          <code>relayUrl</code>=<em>{relayUrl || '(vacío)'}</em> ·{' '}
          <code>callId</code>=<em>{callId || '(vacío)'}</em>
        </small>
      </footer>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  app: {
    display: 'grid',
    gridTemplateRows: 'auto 1fr auto',
    height: '100vh',
    fontFamily: 'Inter, system-ui, sans-serif',
    background: '#f1f5f9',
  },
  header: {
    display: 'flex',
    gap: 16,
    alignItems: 'center',
    padding: '10px 12px',
    background: '#0f172a',
    color: '#fff',
  },
  brand: { fontSize: 14 },
  form: {
    marginLeft: 'auto',
    display: 'flex',
    gap: 10,
    alignItems: 'center',
  },
  label: { display: 'flex', flexDirection: 'column', fontSize: 12, gap: 4 },
  input: {
    height: 30,
    minWidth: 280,
    padding: '0 10px',
    borderRadius: 8,
    border: '1px solid #334155',
    background: '#0b1220',
    color: '#e2e8f0',
    outline: 'none',
  },
  button: {
    height: 32,
    padding: '0 14px',
    borderRadius: 8,
    border: '1px solid #334155',
    background: '#111827',
    color: '#e5e7eb',
    cursor: 'pointer',
  },
  notice: {
    margin: 12,
    padding: 12,
    background: '#fff7ed',
    border: '1px solid #fdba74',
    color: '#9a3412',
    borderRadius: 10,
  },
  main: {
    margin: 12,
    borderRadius: 12,
    background: '#ffffff',
    overflow: 'hidden',
    display: 'grid',
    gridTemplateRows: '1fr',
    boxShadow: '0 4px 16px rgba(0,0,0,.06)',
  },
  placeholder: {
    display: 'grid',
    placeItems: 'center',
    color: '#334155',
  },
  footer: {
    padding: '8px 12px',
    background: '#0f172a',
    color: '#94a3b8',
  },
};
