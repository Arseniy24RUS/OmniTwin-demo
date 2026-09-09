import {describe,it,expect,vi} from 'vitest';
import {parseCityVisualActivation,readCityVisualActivation} from './cityVisualActivation';

const valid={contract:'CityVisualActivationV1',version:1,populationDatasetId:'omnitwin-fictional-city-v2',sourceDatasetVersion:'a'.repeat(64),
  manifest:{url:`https://storage.googleapis.com/omnitwin-demo-city-assets/packs/${'b'.repeat(64)}/city-visual-v1/manifest.json`,bytes:2048,sha256:'c'.repeat(64)}};
describe('independent immutable visual activation',()=>{
  it('requires a root pin in this demo namespace and exact population compatibility',()=>{
    expect(parseCityVisualActivation(valid,valid.populationDatasetId)).toEqual(valid);
    for(const value of [null,{...valid,manifest:{...valid.manifest,sha256:''}},{...valid,sourceDatasetVersion:''},
      {...valid,manifest:{...valid.manifest,url:valid.manifest.url+'?token=secret'}},
      {...valid,manifest:{...valid.manifest,url:valid.manifest.url.replace('omnitwin-demo-city-assets','foreign')}}]){
      expect(()=>parseCityVisualActivation(value,valid.populationDatasetId)).toThrow();
    }
    expect(()=>parseCityVisualActivation(valid,'legacy')).toThrow(/population/i);
  });
  it('allows unpinned local previews only in development on loopback',async()=>{
    const fetcher=vi.fn<typeof fetch>().mockImplementation(async()=>new Response(JSON.stringify(valid)));
    const args={applicationBaseUrl:'http://127.0.0.1:5178/OmniTwin-demo/',development:true,populationDatasetId:valid.populationDatasetId,fetcher};
    expect(await readCityVisualActivation(args)).toMatchObject({mode:'local_preview',manifestUrl:args.applicationBaseUrl+'city-visual-v1/manifest.json'});
    expect(fetcher).not.toHaveBeenCalled();
    expect(await readCityVisualActivation({...args,development:false})).toMatchObject({mode:'published',manifestUrl:valid.manifest.url,manifestIntegrity:valid.manifest});
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(readCityVisualActivation({...args,applicationBaseUrl:'https://example.org/'})).resolves.toMatchObject({mode:'published'});
  });
  it('rejects missing or oversized activation without an unpinned production fallback',async()=>{
    const args={applicationBaseUrl:'https://example.org/',development:false,populationDatasetId:valid.populationDatasetId};
    await expect(readCityVisualActivation({...args,fetcher:vi.fn().mockResolvedValue(new Response('',{status:404}))})).rejects.toThrow(/activation/i);
    await expect(readCityVisualActivation({...args,fetcher:vi.fn().mockResolvedValue(new Response(' '.repeat(32769)))})).rejects.toThrow(/large/i);
  });
});
