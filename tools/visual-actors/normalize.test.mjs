import {test} from 'node:test';
import assert from 'node:assert/strict';
import {normalizeActorFrames} from './normalize.mjs';
test('authored vehicle proportions fit a physical traffic lane with the long axis forward',()=>{
  const frame=Float32Array.from([-4,2,-2,4,2,-2,4,6,2,-4,6,2]);
  const dimensions=normalizeActorFrames([frame],{height:1.6,width:1.85,length:4.5});
  assert.deepEqual(dimensions,{height:1.6,width:1.85,length:4.5});
  for(const [axis,extent]of [[0,1.85],[1,1.6],[2,4.5]]){
    const values=Array.from(frame).filter((_,i)=>i%3===axis);assert.ok(Math.abs(Math.max(...values)-Math.min(...values)-extent)<1e-6);
  }
  assert.equal(Math.min(...Array.from(frame).filter((_,i)=>i%3===1)),0);
});
test('person animation preserves its uniform scale and relative pose',()=>{
  const idle=Float32Array.from([-1,1,-.5,1,3,.5]),walk=Float32Array.from([-1,1.5,-.5,1,3.5,.5]);
  const dimensions=normalizeActorFrames([idle,walk],{height:1.8});assert.equal(dimensions.height,1.8);
  assert.ok(Math.abs(walk[1]-idle[1]-.45)<1e-6);assert.ok(Math.abs(walk[4]-idle[4]-.45)<1e-6);
});
