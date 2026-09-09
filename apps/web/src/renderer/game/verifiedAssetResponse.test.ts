import {afterEach,describe,expect,it,vi} from 'vitest';
import {createHash} from 'node:crypto';
import {verifiedAssetResponse} from './verifiedAssetResponse';

const asset={url:'https://example.org/tiles/child.glb',bytes:7,sha256:createHash('sha256').update('content').digest('hex')};
describe('verified asset transfer progress',()=>{
  afterEach(()=>vi.useRealTimers());
  it('aborts an open body after25s without bytes rather than retaining a staging reservation forever',async()=>{
    vi.useFakeTimers();const cancelled=vi.fn();
    const response=new Response(new ReadableStream<Uint8Array>({cancel:cancelled}));
    let error:unknown;void verifiedAssetResponse(response,asset).catch(value=>{error=value;});
    await vi.advanceTimersByTimeAsync(24999);expect(error).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);expect(error).toMatchObject({name:'CityAssetStallError'});
    expect(cancelled).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
  it('retains a slow progressing body across a longer total download and clears its watchdog after verification',async()=>{
    vi.useFakeTimers();let writer!:ReadableStreamDefaultController<Uint8Array>;
    const response=new Response(new ReadableStream<Uint8Array>({start:controller=>{writer=controller;}}));
    const result=verifiedAssetResponse(response,asset);const encoder=new TextEncoder();
    for(const value of ['con','te','nt']){await vi.advanceTimersByTimeAsync(20000);writer.enqueue(encoder.encode(value));await vi.advanceTimersByTimeAsync(0);}
    writer.close();expect(await (await result).text()).toBe('content');expect(vi.getTimerCount()).toBe(0);
  });
  it('does not count empty chunks as progress or wait for a broken cancellation promise',async()=>{
    vi.useFakeTimers();let writer!:ReadableStreamDefaultController<Uint8Array>;
    const cancelled=vi.fn(()=>new Promise<void>(()=>{}));
    const response=new Response(new ReadableStream<Uint8Array>({start:controller=>{writer=controller;},cancel:cancelled}));
    let error:unknown;void verifiedAssetResponse(response,asset).catch(value=>{error=value;});
    await vi.advanceTimersByTimeAsync(24000);writer.enqueue(new Uint8Array());await vi.advanceTimersByTimeAsync(1000);
    expect(error).toMatchObject({name:'CityAssetStallError'});expect(cancelled).toHaveBeenCalledOnce();expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves explicit cancellation and does not replace an integrity error with a retryable timeout',async()=>{
    const abort=new AbortController(),cancelled=vi.fn();
    const result=verifiedAssetResponse(new Response(new ReadableStream({cancel:cancelled})),asset,abort.signal);
    const rejected=expect(result).rejects.toMatchObject({name:'AbortError'});abort.abort();await rejected;
    expect(cancelled).toHaveBeenCalledOnce();
    await expect(verifiedAssetResponse(new Response('damaged'),asset)).rejects.toThrow('integrity mismatch');
  });
});
