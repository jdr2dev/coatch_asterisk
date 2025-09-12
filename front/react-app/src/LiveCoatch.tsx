// LiveCoach.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react';

type Speaker = 'agent' | 'customer';
type Evt =
  | { type:'partial'|'final'; callId:string; speaker:Speaker; turnId:string; text:string; tsStart?:number; tsEnd?:number; words?:any[] }
  | { type:'coach'; callId:string; turnRef?:string; mode:'tip'|'alert'|'next-best-action'; severity:'low'|'med'|'high'; text:string }
  | { type:'meta'; callId:string; status:string };

type Turn = {
  turnId: string;
  speaker: Speaker;
  finalText: string;
  partialText: string;
  words?: any[];
  closed: boolean;
  tsStart?: number;
  tsEnd?: number;
};

export default function LiveCoach({ relayUrl, callId }:{ relayUrl:string; callId:string }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [coachMsgs, setCoachMsgs] = useState<any[]>([]);
  const wsRef = useRef<WebSocket|null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // 1) Validación temprana
  const propsOk = Boolean(relayUrl && callId);

  // 2) Construcción segura del WS URL
  const wsUrl = useMemo(() => {
    if (!propsOk) return null;
    const base = (relayUrl ?? '').toString().replace(/\/$/, '');
    const cid = encodeURIComponent(callId ?? '');
    // Permite relativo si quieres: new URL('/ws?...', window.location.origin).toString()
    return `${base}/ws?callId=${cid}`;
  }, [relayUrl, callId, propsOk]);

  useEffect(() => {
    if (!wsUrl) return;

    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

    ws.onmessage = (m) => {
      let evt: Evt | null = null;
      try {
        evt = JSON.parse(m.data);
      } catch (e) {
        console.warn('Mensaje WS no es JSON válido:', m.data);
        return;
      }
      if (!evt) return;

      if (evt.type === 'partial') {
        setTurns(prev => {
          const i = prev.findIndex(t => t.turnId === evt!.turnId);
          if (i >= 0) {
            const copy = prev.slice();
            copy[i] = { ...copy[i], partialText: evt!.text, tsEnd: evt!.tsEnd ?? copy[i].tsEnd };
            return copy;
          }
          return [...prev, { turnId: evt.turnId, speaker: evt.speaker, finalText: '', partialText: evt.text, closed:false, tsStart: evt.tsStart, tsEnd: evt.tsEnd }];
        });
      }

      if (evt.type === 'final') {
        setTurns(prev => {
          const i = prev.findIndex(t => t.turnId === evt!.turnId);
          if (i >= 0) {
            const copy = prev.slice();
            copy[i] = { ...copy[i], finalText: evt!.text, words: (evt as any).words, closed:true, partialText:'', tsEnd: evt!.tsEnd ?? copy[i].tsEnd };
            return copy;
          }
          return [...prev, { turnId: evt.turnId, speaker: evt.speaker, finalText: evt.text, partialText:'', closed:true, tsStart: evt.tsStart, tsEnd: evt.tsEnd, words: (evt as any).words }];
        });
      }

      if (evt.type === 'coach') {
        setCoachMsgs(prev => [...prev, { ...(evt as any), at: Date.now() }]);
      }
    };

    // (Opcional) logs básicos
    ws.onopen = () => console.debug('WS conectado:', wsUrl);
    ws.onerror = (e) => console.warn('WS error:', e);
    ws.onclose = () => console.debug('WS cerrado');

    return () => {
      try { ws.close(); } catch {}
    };
  }, [wsUrl]);

  // KPIs
  const kpis = useMemo(() => {
    const agentChars = turns.filter(t=>t.closed && t.speaker==='agent').reduce((a,t)=>a+(t.finalText?.length||0),0);
    const custChars  = turns.filter(t=>t.closed && t.speaker==='customer').reduce((a,t)=>a+(t.finalText?.length||0),0);
    const total = agentChars + custChars || 1;
    return {
      talkListenAgent: (agentChars/total),
      talkListenCustomer: (custChars/total),
      turnsAgent: turns.filter(t=>t.speaker==='agent').length,
      turnsCustomer: turns.filter(t=>t.speaker==='customer').length
    };
  }, [turns]);

  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior:'smooth' }); }, [turns, coachMsgs]);

  // Renderiza aviso útil si faltan props
  if (!propsOk) {
    return (
      <div style={styles.missing}>
        <strong>Live Coaching</strong>
        <div>Config incompleta: faltan <code>relayUrl</code> y/o <code>callId</code>.</div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <Header kpis={kpis} />
      <div style={styles.timeline}>
        {turns.map(t => (
          <Bubble key={t.turnId} speaker={t.speaker} finalText={t.finalText} partialText={t.partialText} />
        ))}
        {coachMsgs.map((c, i) => <CoachBubble key={`c-${i}`} mode={c.mode} severity={c.severity} text={c.text} />)}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

function Header({kpis}:{kpis:any}) {
  return (
    <div style={styles.header}>
      <strong>Live Coaching</strong>
      <div>Agent talk: {(kpis.talkListenAgent*100).toFixed(0)}% · Customer: {(kpis.talkListenCustomer*100).toFixed(0)}%</div>
    </div>
  );
}

function Bubble({speaker, finalText, partialText}:{speaker:Speaker; finalText:string; partialText:string}) {
  const isAgent = speaker === 'agent';
  const text = finalText || partialText || '';
  return (
    <div style={{...styles.bubble, ...(isAgent?styles.agent:styles.customer), opacity: finalText?1:0.7}}>
      <div style={styles.speaker}>{isAgent?'Agente':'Cliente'} {finalText?'':'(escuchando...)'}</div>
      <div style={styles.text}>{text}</div>
      {!finalText && !!partialText && <div style={styles.typing}>•••</div>}
    </div>
  );
}

function CoachBubble({mode, severity, text}:{mode:string; severity:string; text:string}) {
  const color = mode==='alert' ? '#b71c1c' : mode==='next-best-action' ? '#0d47a1' : '#1b5e20';
  const bg = mode==='alert' ? '#ffebee' : mode==='next-best-action' ? '#e3f2fd' : '#e8f5e9';
  return (
    <div style={{...styles.bubble, background:bg, borderColor:color, borderWidth:2, borderStyle:'solid', alignSelf:'center', maxWidth: '80%'}}>
      <div style={{fontSize:12, color}}>{mode.toUpperCase()} · {severity}</div>
      <div style={styles.text}>{text}</div>
    </div>
  );
}

const styles:any = {
  container: { display:'flex', flexDirection:'column', height:'100%', fontFamily:'Inter, system-ui, sans-serif' },
  missing: { padding:'12px', background:'#fff7ed', border:'1px solid #fdba74', color:'#9a3412', borderRadius:8 },
  header: { padding:'8px 12px', background:'#0f172a', color:'#fff', display:'flex', justifyContent:'space-between', alignItems:'center' },
  timeline: { flex:1, overflowY:'auto', padding:'12px', background:'#f8fafc', display:'flex', flexDirection:'column', gap:8 },
  bubble: { maxWidth:'65%', padding:'10px 12px', borderRadius:10, boxShadow:'0 1px 2px rgba(0,0,0,.05)' },
  agent: { alignSelf:'flex-end', background:'#eef2ff' },
  customer: { alignSelf:'flex-start', background:'#fff' },
  speaker: { fontSize:12, color:'#475569', marginBottom:4 },
  text: { fontSize:14, color:'#0f172a', whiteSpace:'pre-wrap' },
  typing: { marginTop:6, color:'#94a3b8', fontSize:12 }
};
