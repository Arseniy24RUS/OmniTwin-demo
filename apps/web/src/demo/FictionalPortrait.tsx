import { Users } from 'lucide-react';
import type { PublicFictionalPersonV1 } from './types';

/** Shared editorial illustrations, not photographic or unique model identities. */
export function FictionalPortrait({person}:{person:PublicFictionalPersonV1}) {
  if (person.age < 18) return <div className={`person-avatar ${person.sex}`} aria-hidden="true"><Users size={37}/></div>;
  const column = person.age < 35 ? 0 : person.age < 55 ? 1 : person.age < 70 ? 2 : 3;
  return <div className="person-avatar illustrated" role="img"
    aria-label="Условный ИИ-портрет вымышленного персонажа"
    title="Общий иллюстрированный образ, не фотография и не уникальная внешность жителя"
    style={{width:72,height:90,backgroundImage:`url(${import.meta.env.BASE_URL}demo/fictional-portraits-v1.png)`,
      backgroundSize:'400% 200%',backgroundPosition:`${column*100/3}% ${person.sex==='female'?100:0}%`}}/>;
}
