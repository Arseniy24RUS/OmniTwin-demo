import { useEffect, useRef, useState } from 'react';
import { Send, MessageCircle } from 'lucide-react';
import { sendResidentMessage, scriptedReply, type ChatMessage } from './chatClient';
import type { DemoContextV1, DemoPresence, PublicFictionalPersonV1 } from './types';

export function ResidentChat({person,context,presence,localPreview=false}:{person:PublicFictionalPersonV1;context:DemoContextV1;presence:DemoPresence|null;localPreview?:boolean}){
 const [messages,setMessages]=useState<ChatMessage[]>([]);const [input,setInput]=useState('');const [busy,setBusy]=useState(false);const [reason,setReason]=useState('');const request=useRef(0);
 useEffect(()=>{request.current++;setMessages([]);setInput('');setBusy(false);setReason('');},[person.id,person.scenario,person.demographicYear]);
 async function send(value:string){if(busy||!value.trim())return; const revision=++request.current;const text=value.trim().slice(0,600);const history=messages;setMessages(m=>[...m,{role:'user',content:text}]);setInput('');setBusy(true);
  const reply=localPreview?{content:scriptedReply(person,text,presence),source:'scripted' as const,reason:'Совместимость новых маршрутов с чатом ещё проверяется'}:await sendResidentMessage(person,context,text,history,presence);if(request.current!==revision)return;
  setMessages(m=>[...m,{role:'assistant',content:reply.content,source:reply.source}]);setReason(reply.reason||'');setBusy(false);
 }
 return <section className="resident-chat" aria-label="Разговор с жителем"><h3><MessageCircle size={17}/> Разговор с жителем</h3><p className="caption">ИИ-диалог с демонстрационным персонажем</p>
  {localPreview&&<p className="caption">Проверка маршрутов: пока доступны демореплики, согласованные с этой сценой.</p>}
  <div className="chat-messages" aria-live="polite">{messages.length===0?<p className="chat-intro">Спросите, кто я, куда направляюсь и как проходит мой день.</p>:messages.map((m,i)=><div key={i} className={`chat-message ${m.role}`}><span>{m.role==='user'?'Вы':person.name.split(' ')[0]}{m.source==='scripted'?' · демореплика':''}</span><p>{m.content}</p></div>)}{busy&&<p role="status">Житель отвечает…</p>}</div>
  {messages.length===0&&<div className="chat-prompts">{['Расскажи о себе','Куда ты направляешься?'].map(q=><button key={q} onClick={()=>void send(q)}>{q}</button>)}</div>}
  {reason&&<p className="caption chat-notice">{reason}. Показана локальная демонстрационная реплика.</p>}
  <form onSubmit={e=>{e.preventDefault();void send(input)}}><input aria-label="Сообщение жителю" value={input} onChange={e=>setInput(e.target.value)} maxLength={600} placeholder="Задайте вопрос…" disabled={busy}/><button className="primary icon-button" aria-label="Отправить сообщение" disabled={busy||!input.trim()}><Send size={18}/></button></form><p className="caption">Не отправляйте персональные данные. Ответы не являются результатами научного расчёта.</p>
 </section>;
}
