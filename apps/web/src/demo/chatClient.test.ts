import { afterEach, describe, expect, it, vi } from 'vitest';
import { fictionalProfile } from './data/fictionalProfile.mjs';
import { DEFAULT_CONTEXT } from './navigation';

const person=fictionalProfile({id:'demo-p-test',birthYear:1995,sex:'female',householdId:'demo-h-test',territoryId:'RU-CHE-SET',entryYear:2026,exitYear:null,entryReason:'initial',exitReason:null},2026,'baseline',DEFAULT_CONTEXT.datasetId,2,'Челябинск');
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules()});

describe('resident chat graceful degradation',()=>{
  it('uses clearly fictional scripted replies with no API request when service is not configured',async()=>{
    const fetch=vi.fn().mockResolvedValue(json({chatApiUrl:null}));vi.stubGlobal('fetch',fetch);
    const {sendResidentMessage}=await import('./chatClient');
    const answer=await sendResidentMessage(person,DEFAULT_CONTEXT,'Кто ты?',[],null);
    expect(answer.source).toBe('scripted');expect(answer.content).toContain('вымышленный');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('never sends a resident message to an insecure public endpoint',async()=>{
    const fetch=vi.fn().mockResolvedValue(json({chatApiUrl:'http://insecure.example/api'}));vi.stubGlobal('fetch',fetch);
    const {sendResidentMessage}=await import('./chatClient');
    expect((await sendResidentMessage(person,DEFAULT_CONTEXT,'Привет',[],null)).source).toBe('scripted');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('sends only a bounded server-verified identity/context and surfaces an LLM response',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(json({chatApiUrl:'https://demo.example/api'}))
      .mockResolvedValueOnce(json({sessionToken:'signed-session-fixture',expiresAt:Date.now()+3600000}))
      .mockResolvedValueOnce(json({source:'llm',reply:'Сейчас я возвращаюсь домой.'}));vi.stubGlobal('fetch',fetch);
    const {sendResidentMessage}=await import('./chatClient');
    const answer=await sendResidentMessage(person,DEFAULT_CONTEXT,'а'.repeat(800),Array.from({length:8},()=>({role:'user' as const,content:'б'.repeat(500)})),null);
    expect(answer.source).toBe('llm');
    const body=JSON.parse(fetch.mock.calls[2][1].body);
    expect(body.personId).toBe(person.id);expect(body.datasetId).toBe(DEFAULT_CONTEXT.datasetId);
    expect(body.message).toHaveLength(600);expect(body.history).toHaveLength(4);
    expect(body.history.every((m:{content:string})=>m.content.length===300)).toBe(true);
    expect(body).not.toHaveProperty('biography');expect(body).not.toHaveProperty('apiKey');
  });
  it('does not automatically retry a rejected quota-consuming request',async()=>{
    const fetch=vi.fn().mockResolvedValueOnce(json({chatApiUrl:'https://demo.example/api'}))
      .mockResolvedValueOnce(json({sessionToken:'signed-session-fixture',expiresAt:Date.now()+3600000}))
      .mockResolvedValueOnce(json({error:'quota_exceeded'},429));vi.stubGlobal('fetch',fetch);
    const {sendResidentMessage}=await import('./chatClient');
    const answer=await sendResidentMessage(person,DEFAULT_CONTEXT,'Привет',[],null);
    expect(answer.source).toBe('scripted');expect(answer.reason).toContain('Лимит');
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
