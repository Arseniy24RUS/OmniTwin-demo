import {describe,it,expect} from 'vitest';
import {isLocalCityApplication} from './localCityApplication';
describe('local city development application boundary',()=>{
  it.each(['http://127.0.0.1:5178/','http://localhost:5178/','https://[::1]:5178/'])('accepts only same-origin local application assets for %s',href=>{
    expect(isLocalCityApplication(true,'/OmniTwin-demo/',href)).toBe(true);
    expect(isLocalCityApplication(false,'/OmniTwin-demo/',href)).toBe(false);
  });
  it.each([
    ['/OmniTwin-demo/','https://arseniy24rus.github.io/OmniTwin-demo/'],
    ['https://assets.test/','http://localhost:5178/'],
    ['http://localhost:5178/','https://public.test/'],
    ['/','http://localhost.attacker.test/'],['/','file:///tmp/index.html'],
    ['/','http://user:password@localhost/'],['http://user:password@localhost/','http://localhost/'],
    ['/','not a URL'],
  ])('rejects development origin/base mismatch %s %s',(base,href)=>expect(isLocalCityApplication(true,base,href)).toBe(false));
});
