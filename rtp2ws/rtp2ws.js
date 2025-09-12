// /opt/asterisk-stt/rtp2ws/rtp2ws.js
import dgram from 'dgram';
import WebSocket from 'ws';

const STT_WS = (speaker, callId) => `ws://127.0.0.1:8080/stream?speaker=${speaker}&callId=${callId}`;
const CALL_ID = process.env.CALL_ID || 'live'; // o inyecta desde tu ARI vía env/IPC
const PORTS = { mix:5000, customer:5001, agent:5002 };

function startLeg(speaker){
  const ws = new WebSocket(STT_WS(speaker, CALL_ID));
  ws.on('open', ()=> console.log(`WS connected -> ${speaker}`));
  ws.on('close', ()=> setTimeout(()=>startLeg(speaker), 500));
  ws.on('error', ()=>{});

  const sock = dgram.createSocket('udp4');
  sock.on('message', msg => {
    // si Asterisk manda RTP: salta 12 bytes. Si manda payload crudo, quita esta línea.
    if (msg.length <= 12) return;
    const payload = msg.subarray(12);
    if (ws.readyState === 1) ws.send(payload);
  });
  sock.bind(PORTS[speaker], ()=> console.log(`RTP L16 ${speaker} udp/${PORTS[speaker]}`));
}

['mix','customer','agent'].forEach(startLeg);
