import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({read:vi.fn(),local:vi.fn(),city:vi.fn(),legacy:vi.fn()}));
vi.mock('./cityAssetActivation',()=>({readCityActivation:mocks.read}));
vi.mock('./localMovementPreview',()=>({readLocalMovementPreview:mocks.local}));
vi.mock('./CityDemoProviderV2',()=>({CityDemoProviderV2:{loadCity:mocks.city}}));
vi.mock('./StaticDemoProvider',()=>({StaticDemoProvider:{load:mocks.legacy}}));
import {loadDemoProvider} from './loadDemoProvider';
describe('movement provider activation selection',()=>{
  beforeEach(()=>{vi.clearAllMocks();vi.stubEnv('DEV',true);vi.stubGlobal('location',{href:'https://app.test/'});mocks.read.mockResolvedValue({});mocks.local.mockResolvedValue(undefined);});
  afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
  it('uses the explicit pinned public descriptor without any development activation lookup',async()=>{
    const movementOverlay={manifest:{url:'https://example.test/frozen.json',bytes:123,sha256:'a'.repeat(64)},baseHashes:{},chatCompatibility:'pending'};
    mocks.read.mockResolvedValue({defaultDatasetId:'omnitwin-fictional-city-v2',cityAssets:{baseUrl:'https://assets.test/',populationManifestSha256:'b'.repeat(64),spatialManifestSha256:'c'.repeat(64)},movementOverlay});
    await loadDemoProvider('https://app.test/');expect(mocks.local).not.toHaveBeenCalled();
    expect(mocks.city).toHaveBeenCalledWith('https://assets.test/',undefined,expect.objectContaining({movementPreviewOverlay:{manifestUrl:movementOverlay.manifest.url,manifestBytes:123,manifestSha256:movementOverlay.manifest.sha256,activation:movementOverlay}}));
  });
  it('preserves opt-in localhost lookup only when no public overlay is declared and excludes legacy',async()=>{
    vi.stubGlobal('location',{href:'http://localhost/#/world?graphics=tiled_game&dataset=omnitwin-fictional-city-v2'});
    await loadDemoProvider('http://localhost/','omnitwin-fictional-city-v2');expect(mocks.local).toHaveBeenCalledTimes(1);
    mocks.local.mockClear();await loadDemoProvider('https://app.test/','omnitwin-public-fictional-chelyabinsk-v1');expect(mocks.local).not.toHaveBeenCalled();expect(mocks.legacy).toHaveBeenCalledTimes(1);
  });
  it.each(['#/world?graphics=tiled_game&dataset=omnitwin-fictional-city-v2',''])('keeps existing Vite %s on matching pinned local sources after public activation',async suffix=>{
    const base='http://127.0.0.1:5178/OmniTwin-demo/',local={manifestUrl:base+'movement-preview-v2/manifest.json',manifestSha256:'d'.repeat(64)};
    const publicOverlay={manifest:{url:'https://assets.test/frozen.json',bytes:123,sha256:'a'.repeat(64)},baseHashes:{},chatCompatibility:'base_profiles_unchanged'};
    mocks.read.mockResolvedValue({defaultDatasetId:'omnitwin-fictional-city-v2',cityAssets:{baseUrl:'https://assets.test/',populationManifestSha256:'b'.repeat(64),spatialManifestSha256:'c'.repeat(64)},movementOverlay:publicOverlay});
    mocks.local.mockResolvedValue(local);vi.stubGlobal('location',{href:base+suffix});
    await loadDemoProvider('/OmniTwin-demo/',suffix?'omnitwin-fictional-city-v2':undefined);
    expect(mocks.local).toHaveBeenCalledOnce();
    expect(mocks.city).toHaveBeenCalledWith('/OmniTwin-demo/',undefined,{applicationBaseURL:'/OmniTwin-demo/',populationManifestSha256:'b'.repeat(64),spatialManifestSha256:'c'.repeat(64),movementPreviewOverlay:local});
  });
  it('keeps a production build served on localhost pinned to its public activation',async()=>{
    vi.stubEnv('DEV',false);vi.stubGlobal('location',{href:'http://localhost:4178/OmniTwin-demo/#/world?graphics=tiled_game&dataset=omnitwin-fictional-city-v2'});
    const overlay={manifest:{url:'https://assets.test/frozen.json',bytes:123,sha256:'a'.repeat(64)},baseHashes:{},chatCompatibility:'pending'};
    mocks.read.mockResolvedValue({defaultDatasetId:'omnitwin-fictional-city-v2',cityAssets:{baseUrl:'https://assets.test/',populationManifestSha256:'b'.repeat(64),spatialManifestSha256:'c'.repeat(64)},movementOverlay:overlay});
    await loadDemoProvider('/OmniTwin-demo/');expect(mocks.local).not.toHaveBeenCalled();expect(mocks.city.mock.calls[0][0]).toBe('https://assets.test/');
  });
  it('propagates local integrity failure without trying the public source or public overlay',async()=>{
    vi.stubGlobal('location',{href:'http://localhost/'});mocks.read.mockResolvedValue({defaultDatasetId:'omnitwin-fictional-city-v2',cityAssets:{baseUrl:'https://assets.test/',populationManifestSha256:'b'.repeat(64),spatialManifestSha256:'c'.repeat(64)}});
    mocks.city.mockRejectedValueOnce(Error('Population manifest pin mismatch'));
    await expect(loadDemoProvider('/')).rejects.toThrow('Population manifest pin mismatch');expect(mocks.city).toHaveBeenCalledOnce();expect(mocks.city.mock.calls[0][0]).toBe('/');
  });
});
