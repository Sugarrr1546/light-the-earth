'use client';
import {useEffect,useRef} from 'react';
import {X} from 'lucide-react';

type Keys=string[][];
/** One row per action; each inner list is one key combination, alternatives side by side. */
function groups(mac:boolean):{title:string;rows:[string,Keys][]}[]{
 const up=mac?['fn','↑']:['PgUp'],down=mac?['fn','↓']:['PgDn'];
 return [
  {title:'浏览地图',rows:[
   ['移动地图',[['←','↑','→','↓']]],
   ['旋转 / 倾斜',[['⇧','←','→'],['⇧','↑','↓']]],
   ['放大 / 缩小',[up,down]],
   ['镜头升高 / 降低',[['⇧',...up],['⇧',...down]]],
   ['停止移动',[['空格']]],
   ['在指针处放大',[['双击']]],
   ['在指针处缩小',[['右键双击']]],
  ]},
  {title:'视图',rows:[
   ['回到地球全景',[['R']]],
   ['切换地球 / 平面',[['O']]],
  ]},
  {title:'其他',rows:[
   ['搜索地方',[['/']]],
   ['关闭面板或菜单',[['esc']]],
   ['显示这份快捷键',[['?']]],
  ]},
 ];
}

export default function ShortcutsDialog({onClose}:{onClose:()=>void}){
 const closeRef=useRef<HTMLButtonElement>(null);
 useEffect(()=>{const trigger=document.activeElement as HTMLElement|null;closeRef.current?.focus();return()=>{if(trigger?.isConnected)trigger.focus();};},[]);
 const mac=typeof navigator!=='undefined'&&/Mac|iPhone|iPad/.test(navigator.userAgent);
 return <div className="modal-backdrop" onClick={onClose}>
  <section role="dialog" aria-modal="true" aria-labelledby="shortcuts-title" className="about-modal shortcuts-dialog" onClick={e=>e.stopPropagation()}>
   <div className="drawer-heading"><span className="eyebrow">KEYBOARD SHORTCUTS</span><button ref={closeRef} className="icon-button" aria-label="关闭快捷键列表" onClick={onClose}><X size={18}/></button></div>
   <h2 id="shortcuts-title">键盘快捷键</h2>
   <p>与网页版 Google Earth 保持一致。在输入框里打字时，单键快捷键不会触发。</p>
   {groups(mac).map(group=><div className="shortcut-group" key={group.title}>
    <h3>{group.title}</h3>
    <dl>{group.rows.map(([label,keys])=><div key={label}><dt>{label}</dt><dd>{keys.map((combo,i)=><span className="shortcut-combo" key={i}>{combo.map(k=><kbd key={k}>{k}</kbd>)}</span>)}</dd></div>)}</dl>
   </div>)}
  </section>
 </div>;
}
