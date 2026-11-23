/** Keyboard shortcuts, following Google Earth on the web. On a Mac keyboard Page Up and Page Down are fn ↑ and fn ↓. */
export type ShortcutAction='help'|'zoom-in'|'zoom-out'|'altitude-up'|'altitude-down'|'reset'|'projection'|'stop'|'move';

export interface ShortcutKey {key:string;shiftKey:boolean;metaKey:boolean;ctrlKey:boolean;altKey:boolean;repeat?:boolean;isComposing?:boolean;}
/** Where the key was pressed: typing in a field always wins, and Space still presses a focused button.
 * `map`: the map itself has focus and handles its arrow keys. `arrows`: a list, radio group, slider or scrolling
 * panel that uses the arrow keys itself. Both are optional and default to false. */
export interface ShortcutTarget {editable:boolean;button:boolean;map?:boolean;arrows?:boolean;}
const ARROWS=new Set(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown']);

/** Zoom steps: Page Up and Page Down match the zoom buttons; with Shift the camera rises or sinks by half as much. */
export const ZOOM_STEP=1,ALTITUDE_STEP=0.5;

export function shortcutFor(event:ShortcutKey,target:ShortcutTarget):ShortcutAction|null{
 // Command, Control and Option combinations belong to the system and the app menu (⌘R reloads, for one).
 if(event.metaKey||event.ctrlKey||event.altKey||event.isComposing||target.editable)return null;
 const held=event.repeat===true;
 switch(event.key){
  case 'PageUp':return event.shiftKey?'altitude-up':'zoom-in';
  case 'PageDown':return event.shiftKey?'altitude-down':'zoom-out';
  case '?':return held?null:'help';
  case ' ':case 'Spacebar':return target.button?null:'stop';
 }
 // As in Google Earth, the arrow keys move the map wherever the focus is, as long as nothing else uses them.
 // Held, they keep moving; with Shift they rotate and tilt.
 if(ARROWS.has(event.key))return target.map||target.arrows?null:'move';
 if(event.shiftKey||held)return null;
 switch(event.key.toLowerCase()){
  case 'r':return 'reset';
  case 'o':return 'projection';
 }
 return null;
}

/** Reads a key event's target in the page. */
export function shortcutTarget(target:EventTarget|null):ShortcutTarget{
 const element=target instanceof Element?target:null;
 return {
  editable:!!element?.closest('input,textarea,select,[contenteditable=""],[contenteditable=true]'),
  button:!!element?.closest('button,a[href],summary,[role=button],[role=switch],[role=radio],[role=option]'),
  map:!!element?.closest('.maplibregl-canvas-container'),
  arrows:!!element?.closest('select,[role=radio],[role=radiogroup],[role=option],[role=listbox],[role=slider],[role=tab],[role=tablist],[role=menu],[role=menuitem],[role=tree],[role=grid]')||scrolls(element),
 };
}
/** Whether the element or a panel around it scrolls, so that the arrow keys scroll it. */
function scrolls(element:Element|null){
 for(let node=element;node&&node!==document.body&&node!==document.documentElement;node=node.parentElement){
  const style=getComputedStyle(node);
  if(/(auto|scroll)/.test(style.overflowY)&&node.scrollHeight>node.clientHeight+1)return true;
  if(/(auto|scroll)/.test(style.overflowX)&&node.scrollWidth>node.clientWidth+1)return true;
 }
 return false;
}
