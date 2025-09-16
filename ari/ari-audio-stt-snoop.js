// ari-audio-stt-snoop.js
// - Bridge principal MIXING (audio OK entre caller y agent)
// - Captura MIX: externalMedia (canal) + añadido al bridge principal
// - Captura por canal (customer/agent): SnoopChannel -> bridge auxiliar -> externalMedia
// - Lanza rtp2ws por llamada con 3 puertos (mix/customer/agent)
// Requiere: npm i ari-client

import AriClient from 'ari-client';
import { spawn } from 'child_process';

const CFG = {
  ARI_URL:  process.env.ARI_URL  || 'http://127.0.0.1:8088',
  ARI_USER: process.env.ARI_USER || 'coach',
  ARI_PASS: process.env.ARI_PASS || 'verysecret',
  APP:      process.env.APP      || 'coach_app',      // app principal (dialplan)
  SNOOP_APP:process.env.SNOOP_APP|| 'coach_snoop',    // app secundaria (para snoops)
  AGENT_EP: process.env.AGENT_EP || 'PJSIP/201',
  STT_HOST: process.env.STT_HOST || '127.0.0.1',
  BASE_PORT:parseInt(process.env.BASE_PORT || '14000', 10),
  TIMEOUT_UP_MS: parseInt(process.env.TIMEOUT_UP_MS || '15000', 10),
  STT_WS_URL: process.env.STT_WS_URL || 'ws://127.0.0.1:8080/stream',
  FORMAT:    process.env.FORMAT || 'ulaw',            // formato de externalMedia (ulaw|alaw|slin16)
};

// ---- Utils ----
function parseArgs(s){ const o={}; (s||'').split(',').forEach(p=>{ const [k,v]=p.split('='); if(k&&v!==undefined)o[k]=v; }); return o; }

async function waitUp(ari, id, who, ms=CFG.TIMEOUT_UP_MS){
  return new Promise((res,rej)=>{
    let ok=false;
    const on=(ev,ch)=>{ if(ch.id===id && ch.state==='Up'){ ok=true; ari.removeListener('ChannelStateChange',on); console.log(`[UP] ${who}`, id); res(); } };
    ari.on('ChannelStateChange', on);
    ari.channels.get({channelId:id}).then(info=>{
      if(!ok && info?.state==='Up'){ ok=true; ari.removeListener('ChannelStateChange', on); console.log(`[UP-fast] ${who}`, id); res(); }
    }).catch(()=>{});
    setTimeout(()=>{ if(!ok){ ari.removeListener('ChannelStateChange', on); rej(new Error(`timeout Up ${who}`)); } }, ms);
  });
}

async function addWithRetry(ari, bridgeId, channelId, label){
  for (let i=0;i<3;i++){
    try { await ari.bridges.addChannel({ bridgeId, channel: channelId }); console.log(`[ADD] ${label} -> ${bridgeId}`); return; }
    catch(e){ console.error(`[ADD-ERR ${i+1}/3] ${label}:`, e?.message||e); await new Promise(r=>setTimeout(r,150)); }
  }
  throw new Error(`No pude añadir ${label}`);
}

let block=0;
function allocPorts(){ const base=CFG.BASE_PORT + (block++ % 100000) * 3; return { mix:base, customer:base+1, agent:base+2 }; }

// Estado por llamada
// callId -> { bridgeId, callerId, agentId, extMixId, aux:{cust:{bId,extId}, agent:{bId,extId}}, child, ports }
const calls = new Map();

AriClient.connect(CFG.ARI_URL, CFG.ARI_USER, CFG.ARI_PASS).then(async ari=>{
  // ========= App principal =========
  ari.on('StasisStart', async (evt, ch) => {
    if (evt.application !== CFG.APP) return;

    const args = parseArgs(evt.args?.[0] || '');
    if ((args.role||'') !== 'caller') return;  // sólo manejamos caller entrante desde dialplan
    const callId = ch.id;
    console.log('[CALLER]', callId, args);

    try {
      // 1) Bridge MIXING y añadir caller
      const bridge = await ari.bridges.create({ type:'mixing' });
      await addWithRetry(ari, bridge.id, ch.id, 'caller');
      console.log('[BRIDGE] create', bridge.id);

      // 2) Originar agente
      const agent = await ari.channels.originate({
        endpoint: CFG.AGENT_EP,
        app: CFG.APP,
        appArgs: `role=agent,bridgeId=${bridge.id},parent=${callId}`,
        callerId: ch.caller?.number || '0000',
        timeout: 45
      });

      // Guarda estado parcial
      const ports = allocPorts();
      calls.set(callId, { bridgeId: bridge.id, callerId: ch.id, agentId: agent.id, extMixId: null, aux:{}, child:null, ports });

      // 3) Cuando el agente esté Up → añadir al bridge, crear externalMedia MIX y lanzar rtp2ws + snoops
      const onAgentUp = async (ev, ag) => {
        if (ag.id !== agent.id) return;
        if (ag.state !== 'Up') return;
        ari.removeListener('ChannelStateChange', onAgentUp);

        try {
          await waitUp(ari, ch.id, 'caller');
          await addWithRetry(ari, bridge.id, agent.id, 'agent');

          // Verificación
          const bi = await ari.bridges.get({ bridgeId: bridge.id });
          console.log('[BRIDGE info]', bi.id, 'class=', bi.bridge_class, 'tech=', bi.technology, 'channels=', bi.channels);

          // === Captura MIX (externalMedia OUT al STT mix) ===
          const { mix, customer, agent:aport } = ports;
          const extMix = await ari.channels.externalMedia({
            app: CFG.APP,
            external_host: `${CFG.STT_HOST}:${mix}`,
            format: CFG.FORMAT,
            encapsulation: 'rtp',
            direction: 'out'
          });
          await addWithRetry(ari, bridge.id, extMix.id, 'extMix');
          console.log('[EM] MIX ->', `${CFG.STT_HOST}:${mix}`, 'ch=', extMix.id);
          calls.get(callId).extMixId = extMix.id;

          // === SNOOP por canal: CUSTOMER ===
          const bCust = await ari.bridges.create({ type:'mixing' });
          const extCust = await ari.channels.externalMedia({
            app: CFG.SNOOP_APP,
            external_host: `${CFG.STT_HOST}:${customer}`,
            format: CFG.FORMAT,
            encapsulation: 'rtp',
            direction: 'out'
          });
          await addWithRetry(ari, bCust.id, extCust.id, 'extCust');
          await ari.channels.snoopChannel({
            channelId: ch.id,
            app: CFG.SNOOP_APP,
            appArgs: `role=customer,bridgeId=${bCust.id}`,
            spy: 'out',         // voz que SALE del caller (lo que él habla)
            whisper: 'none'
          });
          console.log('[SNOOP] customer spy=out -> b', bCust.id);

          // === SNOOP por canal: AGENT ===
          const bAgent = await ari.bridges.create({ type:'mixing' });
          const extAgent = await ari.channels.externalMedia({
            app: CFG.SNOOP_APP,
            external_host: `${CFG.STT_HOST}:${aport}`,
            format: CFG.FORMAT,
            encapsulation: 'rtp',
            direction: 'out'
          });
          await addWithRetry(ari, bAgent.id, extAgent.id, 'extAgent');
          await ari.channels.snoopChannel({
            channelId: agent.id,
            app: CFG.SNOOP_APP,
            appArgs: `role=agent,bridgeId=${bAgent.id}`,
            spy: 'out',         // voz que SALE del agente
            whisper: 'none'
          });
          console.log('[SNOOP] agent spy=out -> b', bAgent.id);

          // Guarda bridges auxiliares
          Object.assign(calls.get(callId), { aux: { cust:{bId:bCust.id, extId:extCust.id}, agent:{bId:bAgent.id, extId:extAgent.id} } });

          // === Lanza rtp2ws por llamada (mix/customer/agent) ===
          const child = spawn('node', [
            '/opt/coatch_asterisk/rtp2ws/call-rtp2ws.js',
            `--callId=${callId}`,
            `--stt=${CFG.STT_WS_URL}`,
            `--mix=${mix}`, `--customer=${customer}`, `--agent=${aport}`
          ], { stdio:'inherit' });
          child.on('exit',(code,signal)=>console.log('[rtp2ws exit]', code, signal));
          calls.get(callId).child = child;

          // Limpieza al colgar cualquiera
          const cleanup = async () => await cleanupCall(ari, callId);
          ch.on('StasisEnd', cleanup);
          agent.on('StasisEnd', cleanup);

        } catch (e) {
          console.error('[ERROR join/capture]', e?.message || e);
          await cleanupCall(ari, callId).catch(()=>{});
        }
      };
      ari.on('ChannelStateChange', onAgentUp);

    } catch (e) {
      console.error('[StasisStart error]', e?.message || e);
      await cleanupCall(ari, callId).catch(()=>{});
    }
  });

  // ========= App secundaria (SNOOP_APP) =========
  // Recibe los SnoopChannels; los añade al bridge auxiliar indicado en appArgs.
  ari.on('StasisStart', async (evt, snoopCh) => {
    if (evt.application !== CFG.SNOOP_APP) return;
    const kv = parseArgs(evt.args?.[0] || '');
    const bId = kv.bridgeId;
    const role = kv.role;
    try {
      if (bId) {
        await addWithRetry(ari, bId, snoopCh.id, `snoop-${role}`);
        console.log(`[SNOOP add] ${role} -> bridge ${bId} (ch=${snoopCh.id})`);
      }
      // Al terminar el snoop, si el bridge queda vacío (o sólo con extMedia), destrúyelo
      snoopCh.on('StasisEnd', async () => {
        try {
          if (!bId) return;
          const binfo = await ari.bridges.get({ bridgeId: bId });
          if (!binfo.channels || binfo.channels.length <= 1) {
            await ari.Bridge({ id: bId }).destroy();
            console.log('[CLEAN] destroyed aux bridge', bId);
          }
        } catch {}
      });
    } catch (e) {
      console.error('[SNOOP_APP error]', e?.message || e);
      try { if (bId) await ari.Bridge({ id: bId }).destroy(); } catch {}
    }
  });

  // Inicia ambas apps
  ari.start(CFG.APP);
  ari.start(CFG.SNOOP_APP);
  console.log('ARI listo:', CFG.APP, '· SNOOP:', CFG.SNOOP_APP);

  // Limpieza global (CTRL+C)
  const onExit = async () => {
    console.log('\n[SHUTDOWN] limpiando llamadas activas…');
    for (const callId of Array.from(calls.keys())) {
      try { await cleanupCall(ari, callId); } catch {}
    }
    process.exit(0);
  };
  process.on('SIGINT', onExit);
  process.on('SIGTERM', onExit);

}).catch(err=>{
  console.error('Error conectando a ARI:', err?.message || err);
});

// ======= Helpers de limpieza =======
async function cleanupCall(ari, callId){
  const st = calls.get(callId);
  if (!st) return;
  console.log('[CLEAN] call', callId);

  // rtp2ws hijo
  try { if (st.child && !st.child.killed) st.child.kill('SIGTERM'); } catch {}

  // externalMedia MIX y bridge principal
  try { if (st.extMixId) await ari.channels.hangup({ channelId: st.extMixId }); } catch {}
  try { if (st.bridgeId) await ari.Bridge({ id: st.bridgeId }).destroy(); } catch {}

  // Bridges/EM auxiliares
  try { if (st.aux?.cust?.extId) await ari.channels.hangup({ channelId: st.aux.cust.extId }); } catch {}
  try { if (st.aux?.cust?.bId)  await ari.Bridge({ id: st.aux.cust.bId }).destroy(); } catch {}
  try { if (st.aux?.agent?.extId) await ari.channels.hangup({ channelId: st.aux.agent.extId }); } catch {}
  try { if (st.aux?.agent?.bId)  await ari.Bridge({ id: st.aux.agent.bId }).destroy(); } catch {}

  // (Opcional) intentar colgar canales si aún existen
  try { if (st.callerId) await ari.channels.hangup({ channelId: st.callerId }); } catch {}
  try { if (st.agentId)  await ari.channels.hangup({ channelId: st.agentId }); } catch {}

  calls.delete(callId);
}
