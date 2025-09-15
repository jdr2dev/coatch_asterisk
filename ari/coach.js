// ari-audio-stt-fixed.js — mixing OK + externalMedia (por bridge) + rtp2ws por llamada
// Nota: en ARI se crea un canal externalMedia y se añade al bridge. No existe bridges.externalMedia.

import AriClient from 'ari-client';
import { spawn } from 'child_process';

const CFG = {
  ARI_URL:'http://127.0.0.1:8088', ARI_USER:'coach', ARI_PASS:'verysecret',
  APP:'coach_app',
  AGENT_EP: process.env.AGENT_EP || 'PJSIP/201',
  STT_HOST: process.env.STT_HOST || '127.0.0.1',
  BASE_PORT: parseInt(process.env.BASE_PORT || '14000',10),
};

function parseArgs(s){ const o={}; (s||'').split(',').forEach(p=>{ const [k,v]=p.split('='); if(k&&v!==undefined)o[k]=v; }); return o; }
async function waitUp(ari, id, who, ms=15000){
  return new Promise((res,rej)=>{
    let ok=false;
    const on=(ev,ch)=>{ if(ch.id===id && ch.state==='Up'){ ok=true; ari.removeListener('ChannelStateChange',on); console.log(`[UP] ${who}`, id); res(); } };
    ari.on('ChannelStateChange',on);
    ari.channels.get({channelId:id}).then(info=>{ if(!ok && info?.state==='Up'){ ok=true; ari.removeListener('ChannelStateChange',on); console.log(`[UP-fast] ${who}`, id); res(); } }).catch(()=>{});
    setTimeout(()=>{ if(!ok){ ari.removeListener('ChannelStateChange',on); rej(new Error(`timeout Up ${who}`)); } }, ms);
  });
}
async function addWithRetry(ari, bridgeId, channelId, label){
  for (let i=0;i<3;i++){
    try { await ari.bridges.addChannel({ bridgeId, channel: channelId }); console.log(`[ADD] ${label} -> ${bridgeId}`); return; }
    catch(e){ console.error(`[ADD-ERR ${i+1}/3] ${label}:`, e?.message||e); await new Promise(r=>setTimeout(r,150)); }
  }
  throw new Error(`No pude añadir ${label}`);
}

let block=0; function allocPorts(){ const base=CFG.BASE_PORT+(block++%100000)*3; return {mix:base, customer:base+1, agent:base+2}; }

AriClient.connect(CFG.ARI_URL, CFG.ARI_USER, CFG.ARI_PASS).then(async ari=>{
  ari.on('StasisStart', async (evt, caller) => {
    if (evt.application !== CFG.APP) return;
    const args = parseArgs(evt.args?.[0] || '');
    if ((args.role||'') !== 'caller') return;

    console.log('[CALLER]', caller.id, args);

    // 1) mixing bridge + caller
    const bridge = await ari.bridges.create({ type:'mixing' });
    console.log('[BRIDGE create]', bridge.id);
    await addWithRetry(ari, bridge.id, caller.id, 'caller');

    // 2) origina agente
    const agent = await ari.channels.originate({
      endpoint: CFG.AGENT_EP,
      app: CFG.APP,
      appArgs: `role=agent,bridgeId=${bridge.id},parent=${caller.id}`,
      callerId: caller.caller?.number || '0000',
      timeout: 45
    });

    // 3) cuando agent=Up -> añade, crea externalMedia (mix) y lanza rtp2ws
    const onState = async (ev, ch) => {
      if (ch.id !== agent.id) return;
      if (ch.state === 'Up') {
        ari.removeListener('ChannelStateChange', onState);
        try {
          await waitUp(ari, caller.id, 'caller');
          await addWithRetry(ari, bridge.id, agent.id, 'agent');

          // Verificación
          const bi = await ari.bridges.get({ bridgeId: bridge.id });
          console.log('[BRIDGE info]', bi.id, 'class=', bi.bridge_class, 'tech=', bi.technology, 'channels=', bi.channels);

          // === Captura STT: MIX del bridge ===
          const {mix, customer, agent:aport} = allocPorts();

          // 3.1 Crear canal externalMedia (direction=out) y añadirlo al bridge para sacar el MIX
          const extMix = await ari.channels.externalMedia({
            app: CFG.APP,
            external_host: `${CFG.STT_HOST}:${mix}`,
            format: 'slin16',
            encapsulation: 'rtp',
            direction: 'out'
          });
          await addWithRetry(ari, bridge.id, extMix.id, 'extMix');
          console.log('[EM] mix ->', `${CFG.STT_HOST}:${mix}`, 'channel=', extMix.id);

          // (Opcional avanzado) Captura por-rol:
          // Para sacar "customer" y "agent" por separado se recomienda usar SnoopChannel + otro bridge pequeño
          // y en cada uno añadir un externalMedia 'out'. Lo dejo como TODO para mantener simple el audio base.

          // Lanza rtp2ws por llamada (escuchará mix/customer/agent, aunque de momento solo enviamos mix)
          const child = spawn('node', [
            '/opt/coatch_asterisk/rtp2ws/call-rtp2ws.js',
            `--callId=${caller.id}`,
            `--stt=ws://127.0.0.1:8080/stream`,
            `--mix=${mix}`, `--customer=${customer}`, `--agent=${aport}`
          ], { stdio:'inherit' });
          child.on('exit',(c,s)=>console.log('[rtp2ws exit]',c,s));

          // Limpieza al colgar
          const destroy = async ()=>{
            try{ await ari.Bridge({id: bridge.id}).destroy(); }catch{}
            try{ if(!child.killed) child.kill('SIGTERM'); }catch{}
          };
          caller.on('StasisEnd', destroy);
          agent.on('StasisEnd', destroy);

        } catch (e) {
          console.error('[ERROR en añadido/captura]', e.message);
          try{ await ari.Bridge({id: bridge.id}).destroy(); }catch{}
        }
      }
    };
    ari.on('ChannelStateChange', onState);
  });

  ari.start(CFG.APP);
  console.log('ARI listo (audio+STT MIX):', CFG.APP);
}).catch(console.error);
