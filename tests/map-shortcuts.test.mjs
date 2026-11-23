import test from 'node:test';import assert from 'node:assert/strict';
import {shortcutFor} from '../lib/map-shortcuts.ts';
const key=(value,extra={})=>({key:value,shiftKey:false,metaKey:false,ctrlKey:false,altKey:false,...extra});
const map={editable:false,button:false};

test('keys follow Google Earth on the web',()=>{
 assert.equal(shortcutFor(key('?',{shiftKey:true}),map),'help');
 assert.equal(shortcutFor(key('PageUp'),map),'zoom-in');
 assert.equal(shortcutFor(key('PageDown'),map),'zoom-out');
 assert.equal(shortcutFor(key('PageUp',{shiftKey:true}),map),'altitude-up');
 assert.equal(shortcutFor(key('PageDown',{shiftKey:true}),map),'altitude-down');
 assert.equal(shortcutFor(key('r'),map),'reset');
 assert.equal(shortcutFor(key('R'),map),'reset','Caps Lock on');
 assert.equal(shortcutFor(key('o'),map),'projection');
 assert.equal(shortcutFor(key(' '),map),'stop');
});
test('typing, system combinations and focused buttons keep their keys',()=>{
 for(const k of ['r','o',' ','PageUp','?'])assert.equal(shortcutFor(key(k),{editable:true,button:false}),null,`typing ${k}`);
 assert.equal(shortcutFor(key('r',{metaKey:true}),map),null,'⌘R reloads');
 assert.equal(shortcutFor(key('o',{ctrlKey:true}),map),null);
 assert.equal(shortcutFor(key('PageUp',{altKey:true}),map),null);
 assert.equal(shortcutFor(key('r',{shiftKey:true}),map),null);
 assert.equal(shortcutFor(key('r',{isComposing:true}),map),null,'an input method is composing');
 assert.equal(shortcutFor(key(' '),{editable:false,button:true}),null,'Space presses the focused button');
 assert.equal(shortcutFor(key('r'),{editable:false,button:true}),'reset');
});
test('holding a key repeats zoom but not toggles',()=>{
 assert.equal(shortcutFor(key('PageUp',{repeat:true}),map),'zoom-in');
 assert.equal(shortcutFor(key('PageDown',{shiftKey:true,repeat:true}),map),'altitude-down');
 for(const k of ['o','r','?',' '])assert.equal(shortcutFor(key(k,{repeat:true,shiftKey:k==='?'}),map),k===' '?'stop':null,k);
});
test('arrow keys move the map wherever the focus is, unless something else uses them',()=>{
 for(const k of ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']){
  assert.equal(shortcutFor(key(k),map),'move',k);
  assert.equal(shortcutFor(key(k,{shiftKey:true}),map),'move','Shift rotates or tilts');
  assert.equal(shortcutFor(key(k,{repeat:true}),map),'move','held keys keep moving');
  assert.equal(shortcutFor(key(k),{editable:false,button:true}),'move','a focused button does not use arrows');
  assert.equal(shortcutFor(key(k),{editable:true,button:false}),null,'typing moves the caret');
  assert.equal(shortcutFor(key(k),{...map,map:true}),null,'the focused map handles its own keys');
  assert.equal(shortcutFor(key(k),{...map,arrows:true}),null,'lists, radio groups and scrolling panels keep their keys');
  assert.equal(shortcutFor(key(k,{metaKey:true}),map),null,'⌘ arrows belong to the system');
 }
});
