// coach.js  (ESM, Node >= 18)
// Ejecuta: node coach.js
// Env vars (opcionales):
//   ARI_URL=http://127.0.0.1:8088  ARI_USER=coach  ARI_PASS=verysecret  ARI_APP=coach_app  AGENT_ENDPOINT=PJSIP/1001

import AriClient from 'ari-client';

const ARI_URL  = process.env.ARI_URL  || 'http://127.0.0.1:8088';
const ARI_USER = process.env.ARI_USER || 'coach';
const ARI_PASS = process.env.ARI_PASS || 'verysecret';
const APP      = process.env.ARI_APP  || 'coach_app';
const AGENT_ENDPOINT = process.env.AGENT_ENDPOINT || 'PJSIP/201';

// Estado en memoria: linkedid -> { bridgeId, legs:{channelId:{...}}, agentDialed, createdAt }
const calls = new Map();

function ensureCall(linkedid) {
  let c = calls.get(linkedid);
  if (!c) {
    c = { linkedid, bridgeId: undefined, legs: {}, agentDialed: false, createdAt: Date.now() };
    calls.set(linkedid, c);
  }
  return c;
}

function safeNum(n) {
  return (n || '').trim();
}

function log(...args) { console.log(new Date().toISOString(), ...args); }
function warn(...args) { console.warn(new Date().toISOString(), ...args); }

// Helpers ---------------
async function getOrCreateBridge(ari, call) {
  if (call.bridgeId) return call.bridgeId;
  // Crear bridge de tipo mixing
  const bridge = ari.Bridge();
  await bridge.create({ type: 'mixing' });
  call.bridgeId = bridge.id;
  log('[BRIDGE] created', bridge.id, 'linkedid=', call.linkedid);
  return call.bridgeId;
}

async function addIfNeeded(ari, call, channelId) {
  const leg = call.legs[channelId];
  if (!leg || leg.addedToBridge) return;
  const bridgeId = await getOrCreateBridge(ari, call);
  try {
    await ari.bridges.addChannel({ bridgeId, channel: channelId });
    leg.addedToBridge = true;
    log('[BRIDGE] addChannel ok', bridgeId, 'ch=', channelId, 'role=', leg.role);
  } catch (e) {
    warn('[BRIDGE] addChannel fail', bridgeId, 'ch=', channelId, e && (e.message || e));
  }
}

async function originateAgentIfNeeded(ari, call) {
  if (call.agentDialed) return;
  call.agentDialed = true;
  try {
    const ch = await ari.channels.originate({
      endpoint: AGENT_ENDPOINT,
      app: APP,
      appArgs: 'agent',               // ← rol explícito
      variables: { ROLE: 'agent' },   // (opcional)
      callerId: 'Coach <6000>',
      timeout: 30
    });
    log('[ORIGINATE] agent dialing', AGENT_ENDPOINT, '-> ch=', ch.id, 'linkedid=', call.linkedid);
  } catch (e) {
    warn('[ORIGINATE] agent failed', e && (e.message || e));
  }
}

function roleFrom(evt /*, channel */) {
  const fromArgs = Array.isArray(evt?.args) ? evt.args[0] : undefined;
  const v = (fromArgs || '').toLowerCase();
  if (v === 'inbound' || v === 'agent') return v;
  return 'unknown';
}

async function cleanupIfDone(ari, linked) {
  const call = calls.get(linked);
  if (!call) return;

  const legsLeft = Object.keys(call.legs).length;
  if (legsLeft > 0) return;

  try {
    if (call.bridgeId) {
      try {
        await ari.bridges.destroy({ bridgeId: call.bridgeId });
        log('[BRIDGE] destroyed', call.bridgeId, 'linkedid=', linked);
      } catch {
        // puede estar ya destruido
      }
    }
  } finally {
    calls.delete(linked);
    log('[CLEAN] removed state linkedid=', linked);
  }
}

// ---- MAIN ----
(async () => {
  const ari = await AriClient.connect(ARI_URL, ARI_USER, ARI_PASS);
  log(`[BOOT] Connected to ARI ${ARI_URL}, starting app=${APP}`);

  // ----------------- EVENTOS ARI -----------------

  // Un canal entra en la app
  ari.on('StasisStart', async (evt, channel) => {
    const chId = channel.id;
    const linked = channel.linkedid || chId; // fallback
    const role = roleFrom(evt, channel);

    const call = ensureCall(linked);
    call.legs[chId] = {
      id: chId,
      role,
      ready: Boolean(channel.caller?.number),
      caller: safeNum(channel.caller?.number),
      connected: safeNum(channel.connected?.number),
      addedToBridge: false
    };

    log('[ARI] StasisStart ch=', chId, 'role=', role, 'linkedid=', linked, 'caller=', call.legs[chId].caller || '(none)');

    if (role === 'inbound') {
      // Asegura contestación del leg entrante (por si no viene contestado del dialplan)
      try { await channel.answer(); } catch {}
      // Origina al agente una sola vez por linkedid
      await originateAgentIfNeeded(ari, call);
    }

    // Prepara bridge y si está listo el leg, añádelo
    await getOrCreateBridge(ari, call);
    if (call.legs[chId].ready) {
      await addIfNeeded(ari, call, chId);
    }
  });

  // Cuando se conoce el callerId
  ari.on('ChannelCallerId', async (evt, channel) => {
    const chId = channel.id;
    const linked = channel.linkedid || chId;
    const call = calls.get(linked);
    if (!call) return;

    const leg = call.legs[chId];
    if (!leg) return;

    leg.caller = safeNum(channel.caller?.number) || leg.caller;
    leg.connected = safeNum(channel.connected?.number) || leg.connected;

    if (!leg.ready) {
      leg.ready = true;
      log('[ARI] CallerId ready ch=', chId, 'role=', leg.role, 'caller=', leg.caller);
      await addIfNeeded(ari, call, chId);
    }
  });

  // Cuando el canal cambia a Up
  ari.on('ChannelStateChange', async (evt, channel) => {
    if (channel?.state !== 'Up') return;
    const chId = channel.id;
    const linked = channel.linkedid || chId;
    const call = calls.get(linked);
    if (!call) return;

    const leg = call.legs[chId];
    if (!leg) return;

    if (!leg.ready) {
      leg.caller = leg.caller || safeNum(channel.caller?.number) || safeNum(channel.connected?.number);
      leg.ready = true;
      log('[ARI] State Up -> ready ch=', chId, 'role=', leg.role, 'caller=', leg.caller);
      await addIfNeeded(ari, call, chId);
    }
  });

  // Fin de Stasis del canal
  ari.on('StasisEnd', async (evt, channel) => {
    const chId = channel.id;
    const linked = channel.linkedid || chId;
    const call = calls.get(linked);
    if (!call) return;

    delete call.legs[chId];
    log('[ARI] StasisEnd ch=', chId, 'linkedid=', linked);
    await cleanupIfDone(ari, linked);
  });

  // Canal destruido
  ari.on('ChannelDestroyed', async (evt, channel) => {
    const chId = channel.id;
    const linked = channel.linkedid || chId;
    const call = calls.get(linked);
    if (!call) return;

    delete call.legs[chId];
    log('[ARI] ChannelDestroyed ch=', chId, 'linkedid=', linked);
    await cleanupIfDone(ari, linked);
  });

  // Bridge destruido (si llega)
  ari.on('BridgeDestroyed', async (evt) => {
    const bridgeId = evt?.bridge?.id;
    if (!bridgeId) return;
    for (const c of calls.values()) {
      if (c.bridgeId === bridgeId) c.bridgeId = undefined;
    }
    log('[BRIDGE] destroyed event', bridgeId);
  });

  // Errores
  ari.on('error', (err) => {
    warn('[ARI] error', err && (err.message || err));
  });

  // IMPORTANTE: iniciar la app ARI (sustituye a apps.subscribe)
  ari.start(APP);

  // Señales de proceso
  process.on('SIGINT', () => { log('SIGINT'); process.exit(0); });
  process.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });
})().catch((e) => {
  console.error('FATAL', e && (e.stack || e));
  process.exit(1);
});
