import test from 'node:test';import assert from 'node:assert/strict';
import {createAppearanceController,normalizeAppearance} from '../lib/appearance.ts';
test('appearance defaults to system and responds live to system changes',()=>{
 let dark=false,change;const published=[];
 const c=createAppearanceController({read:()=>null,write:()=>{},isSystemDark:()=>dark,subscribeSystem:fn=>{change=fn;return()=>{change=null;};},publish:v=>published.push(v)});
 assert.deepEqual(published.at(-1),{preference:'system',resolved:'light'});
 dark=true;change();assert.equal(published.at(-1).resolved,'dark');c.dispose();assert.equal(change,null);
});
test('manual preference persists and overrides system until system is selected again',()=>{
 let dark=true,change,saved;const published=[];
 const c=createAppearanceController({read:()=>null,write:v=>{saved=v;},isSystemDark:()=>dark,subscribeSystem:fn=>{change=fn;return()=>{};},publish:v=>published.push(v)});
 c.setPreference('light');assert.equal(saved,'light');dark=false;change();dark=true;change();assert.equal(published.at(-1).resolved,'light');c.setPreference('system');assert.equal(published.at(-1).resolved,'dark');c.dispose();
});
test('blocked storage still allows a current-session selection and invalid stored values are ignored',()=>{
 assert.equal(normalizeAppearance('dark; arbitrary'),'system');let state;
 const c=createAppearanceController({read:()=>{throw Error('blocked');},write:()=>{throw Error('blocked');},isSystemDark:()=>false,subscribeSystem:()=>()=>{},publish:v=>{state=v;}});
 assert.equal(state.preference,'system');c.setPreference('dark');assert.equal(state.resolved,'dark');c.dispose();
});
