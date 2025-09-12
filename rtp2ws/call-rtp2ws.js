// node call-rtp2ws.js --callId=abc123 --stt=ws://127.0.0.1:8080/stream --mix=5000 --customer=5001 --agent=5002
import dgram from 'dgram';
import WebSocket from 'ws';

const args = Object.fromEntries(process.argv.slice(2).map(a=>{
  const [k,v]=a.replace(/^--/,'').split('='); return [k,v];
}));

const CALL_ID = args.callId || 'live';
const STT = args.stt || 'ws://127.0.0.1:8080/stream';
const PORTS = {
  mix: parseInt(args.mix||'5000'),
  customer: parseInt(args.customer||'5001'),
  agent: parseInt(args.agent||'5002'),
};

function startLeg(speaker, port){
  const url = `${STT}?callId=${encodeURIComponent(CALL_ID)}&speaker=${speaker}`;
  const ws = new WebSocket(url);
  ws.on('open', ()=> console.log(`[${CALL_ID}] WS->STT abierto (${speaker})`));
  ws.on('close', ()=> console.log(`[${CALL_ID}] WS cerrado (${speaker})`));
  ws.on('error', err => console.error(`[${CALL_ID}] WS error ${speaker}`, err?.message));

  const sock = dgram.createSocket('udp4');
  sock.on('message', msg => {
    // Si viene RTP estándar: descarta 12 bytes de cabecera
    if (msg.length <= 12) return;
    const payload = msg.subarray(12);
    if (ws.readyState === 1) ws.send(payload);
  });
  sock.bind(port, ()=> console.log(`[${CALL_ID}] UDP ${speaker} -> ${port}`));

  // cierre ordenado
  const stop = ()=> { try{sock.close();}catch{} try{ws.close();}catch{} };
  return stop;
}

const stops = [
  startLeg('mix', PORTS.mix),
  startLeg('customer', PORTS.customer),
  startLeg('agent', PORTS.agent)
];

process.on('SIGTERM', ()=> { stops.forEach(f=>f()); setTimeout(()=>process.exit(0),150); });
process.on('SIGINT',  ()=> { stops.forEach(f=>f()); setTimeout(()=>process.exit(0),150); });
