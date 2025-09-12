// coach-ari-ports.js
import AriClient from 'ari-client';
import { spawn } from 'child_process';

const ARI_URL='http://127.0.0.1:8088', ARI_USER='coach', ARI_PASS='verysecret';
const APP='coach_app';
const STT_HOST='127.0.0.1';
const BASE_PORT=14000; // incrementa por llamada
let nextBlock = 0;

const inUse = new Map(); // callId -> {bridgeId, custId, agentId, ports, child}

function allocPorts(){
  const base = BASE_PORT + nextBlock*3;
  nextBlock = (nextBlock+1) % 10000;
  return { mix:base, customer:base+1, agent:base+2 };
}

AriClient.connect(ARI_URL, ARI_USER, ARI_PASS).then(async ari => {

  ari.on('StasisStart', async (evt, ch) => {
    const callId = ch.id; // o usa SIPCALLID si prefieres
    const ports = allocPorts();

    // Bridge
    const bridge = await ari.bridges.create({type:'mixing'});
    await bridge.addChannel({channel: ch.id});

    // Origina agente
    const agent = await ari.channels.originate({
      endpoint: 'PJSIP/1001',
      app: APP,
      appArgs: `role=agent,bridgeId=${bridge.id},callId=${callId}`,
      callerId: ch.caller?.number || '0000'
    });

    // Espera a que el agente entre para unir y activar media
    const onAgentJoin = async (ev, ch2) => {
      if (ev.args?.[0]?.includes(`role=agent`) && ev.args?.[0]?.includes(`bridgeId=${bridge.id}`)) {
        await ari.bridges.addChannel({ bridgeId: bridge.id, channel: ch2.id });

        // --- ExternalMedia hacia puertos únicos ---
        await ari.bridges.externalMedia({
          bridgeId: bridge.id, external_host: `${STT_HOST}:${ports.mix}`,
          format: 'slin16', encapsulation: 'rtp', direction: 'out'
        });
        await ari.channels.externalMedia({
          app: APP, channelId: ch.id, external_host: `${STT_HOST}:${ports.customer}`,
          format: 'slin16', encapsulation: 'rtp', direction: 'out'
        });
        await ari.channels.externalMedia({
          app: APP, channelId: ch2.id, external_host: `${STT_HOST}:${ports.agent}`,
          format: 'slin16', encapsulation: 'rtp', direction: 'out'
        });

        // --- Lanza rtp2ws por esta llamada ---
        const args = [
          `/opt/asterisk-stt/rtp2ws/call-rtp2ws.js`,
          `--callId=${callId}`,
          `--stt=ws://127.0.0.1:8080/stream`,
          `--mix=${ports.mix}`, `--customer=${ports.customer}`, `--agent=${ports.agent}`
        ];
        const child = spawn('node', args, { stdio:'inherit' });

        inUse.set(callId, { bridgeId: bridge.id, custId: ch.id, agentId: ch2.id, ports, child });
        ari.removeListener('StasisStart', onAgentJoin);
      }
    };
    ari.on('StasisStart', onAgentJoin);

    // Limpieza al colgar cualquiera
    const cleanup = async () => {
      const s = inUse.get(callId);
      if (s?.child && !s.child.killed) s.child.kill('SIGTERM');
      try { await ari.Bridge({id: s?.bridgeId || bridge.id}).destroy(); } catch {}
      inUse.delete(callId);
    };
    ch.on('StasisEnd', cleanup);
    agent.on('StasisEnd', cleanup);
  });

  ari.start(APP);
  console.log(`ARI '${APP}' listo.`);
}).catch(console.error);


