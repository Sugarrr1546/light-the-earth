/** Keyboard shortcuts, following Google Earth on the web. On a Mac keyboard Page Up and Page Down are fn ↑ and fn ↓. */
export type ShortcutAction='help'|'zoom-in'|'zoom-out'|'altitude-up'|'altitude-down'|'reset'|'projection'|'stop';

export interface ShortcutKey {key:string;shiftKey:boolean;metaKey:boolean;ctrlKey:boolean;altKey:boolean;repeat?:boolean;isComposing?:boolean;}
/** Where the key was pressed: typing in a field always wins, and Space still presses a focused button. */
export interface ShortcutTarget {editable:boolean;button:boolean;}

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
 };
}
