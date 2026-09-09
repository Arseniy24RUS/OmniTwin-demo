import test from 'node:test';
import assert from 'node:assert/strict';
import {roadModePolicy,roadVisualWeight} from './movement-road-policy.mjs';
const road=(className,extra={})=>({className,walkable:true,drivable:true,oneway:false,...extra});
test('walk permission on a carriageway never invents a sidewalk centerline',()=>{
 for(const kind of ['primary','secondary','tertiary','residential','service'])assert.equal(roadModePolicy(road(kind),'walk').eligible,false);
 for(const kind of ['footway','pedestrian','path','steps'])assert.equal(roadModePolicy(road(kind,{drivable:false}),'walk').eligible,true);
 assert.equal(roadModePolicy(road('living_street'),'walk').eligible,true);
 assert.equal(roadModePolicy(road('footway',{walkable:false}),'walk').eligible,false);
 assert.equal(roadModePolicy(road('footway'),'car').eligible,false);
 assert.equal(roadModePolicy(road('cycleway',{drivable:false}),'walk').eligible,false);
});
test('mode-specific normalized direction and access stay separate',()=>{
 const shared=road('living_street',{oneway:true});
 assert.equal(roadModePolicy(shared,'car').reverse,false);assert.equal(roadModePolicy(shared,'walk').reverse,true);
 assert.equal(roadModePolicy({...shared,walkDirection:'forward'},'walk').reverse,false);
 assert.equal(roadModePolicy({...shared,walkDirection:'reverse'},'walk').forward,false);
 assert.equal(roadModePolicy(road('primary',{sourceAttributes:{motor_vehicle:'no'}}),'car').eligible,false);
 assert.equal(roadModePolicy(road('footway',{drivable:false,sourceAttributes:{access:'private'}}),'walk').eligible,false);
});
test('synthetic allocation weight favors connected major streets over short service dead ends',()=>{
 const main=roadVisualWeight(road('primary',{lanes:4}),'car',{lengthMeters:400,connectedExits:2});
 const dead=roadVisualWeight(road('service'),'car',{lengthMeters:20,connectedExits:1});
 assert.ok(main>dead*8);assert.ok(dead>0);assert.equal(roadVisualWeight(road('primary'),'walk'),0);
});
