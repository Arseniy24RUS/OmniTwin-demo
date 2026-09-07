import type { PublicFictionalPersonV1, DemoContextV1, DemoPresence } from './types';
export interface ChatMessage { role:'user'|'assistant'; content:string; source?:'llm'|'scripted' }
interface ChatConfig {chatApiUrl:string|null}
let configPromise:Promise<ChatConfig>|undefined;
let session:{token:string;expiresAt:number}|null=null;
function configuration(){return configPromise??=fetch(`${import.meta.env.BASE_URL}runtime-config.json`).then(r=>{if(!r.ok)throw new Error('config');return r.json() as Promise<ChatConfig>}).catch(()=>({chatApiUrl:null}));}
export function scriptedReply(person:PublicFictionalPersonV1,message:string,presence:DemoPresence|null){
  const text=message.toLocaleLowerCase('ru');
  if(/кто|зовут|расскаж|возраст/.test(text))return `Меня зовут ${person.name}, мне ${person.age}. Моё занятие — ${person.occupation.toLocaleLowerCase('ru')}. Мне интересны ${person.interests.join(', ')}. Я вымышленный житель демонстрационного Челябинска.`;
  if(/где|куда|сейчас|почему|делаешь/.test(text))return `Я в Челябинске, ${person.territoryName}. ${presence?.activity||'Моё положение на карте ещё уточняется по загруженным зданиям.'} Мой маршрут — иллюстрация повседневной жизни, а не наблюдение за реальным человеком.`;
  if(/работ|уч|професс/.test(text))return `Моё занятие — ${person.occupation.toLocaleLowerCase('ru')}. ${presence?.activity||'Сегодня мой день проходит в Челябинске.'} Вне повседневных дел мне интересны ${person.interests.join(', ')}.`;
  if(/прогноз|модель|точн|населени/.test(text))return 'Я демонстрационный персонаж, поэтому не могу подтверждать точность модели. Научная валидация ещё не завершена; сценарии здесь показывают, как можно будет изучать результаты.';
  return `Мне интересны ${person.interests.join(', ')}. Пока я могу рассказать о себе, своём занятии и текущем местоположении. Это локальная демонстрационная реплика; свободный ИИ-диалог ещё не подключён.`;
}
export async function sendResidentMessage(person:PublicFictionalPersonV1,context:DemoContextV1,message:string,history:ChatMessage[],presence:DemoPresence|null):Promise<{content:string;source:'llm'|'scripted';reason?:string}>{
  const config=await configuration();
  const fallback=(reason:string)=>({content:scriptedReply(person,message,presence),source:'scripted' as const,reason});
  if(!config.chatApiUrl)return fallback('ИИ-сервис ещё не подключён');
  try{
    const endpoint=new URL(config.chatApiUrl);
    if(endpoint.protocol!=='https:' && !['127.0.0.1','localhost'].includes(endpoint.hostname))return fallback('Небезопасная конфигурация сервиса');
    const base=endpoint.href.replace(/\/$/,'');
    if(!session||session.expiresAt<Date.now()+60000){
      const response=await fetch(`${base}/session`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}',signal:AbortSignal.timeout(15000)});
      if(!response.ok)return fallback('ИИ-сервис временно недоступен');
      const data=await response.json();session={token:data.sessionToken,expiresAt:typeof data.expiresAt==='number'?(data.expiresAt<1e12?data.expiresAt*1000:data.expiresAt):Date.parse(data.expiresAt)};
    }
    const response=await fetch(`${base}/chat`,{method:'POST',headers:{'Content-Type':'application/json'},signal:AbortSignal.timeout(28000),body:JSON.stringify({personId:person.id,datasetId:context.datasetId,scenario:context.scenario,year:context.year,presentationMinutes:context.presentationMinutes,message:message.slice(0,600),history:history.slice(-4).map(({role,content})=>({role,content:content.slice(0,300)})),sessionToken:session.token,requestId:crypto.randomUUID()})});
    if(!response.ok)return fallback(response.status===429?'Лимит ИИ-диалога исчерпан':'ИИ-сервис временно недоступен');
    const data=await response.json();
    return data.source==='llm'&&typeof data.reply==='string'?{content:data.reply,source:'llm'}:fallback('ИИ-сервис временно недоступен');
  }catch{return fallback('Нет соединения с ИИ-сервисом');}
}
