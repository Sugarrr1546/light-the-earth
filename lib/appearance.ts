export type AppearancePreference='system'|'light'|'dark';
export type ResolvedAppearance='light'|'dark';
export const APPEARANCE_KEY='atlas-appearance';
export function normalizeAppearance(value:unknown):AppearancePreference{return value==='light'||value==='dark'?value:'system';}
interface Options{read:()=>unknown;write:(value:AppearancePreference)=>void;isSystemDark:()=>boolean;subscribeSystem:(fn:()=>void)=>(()=>void);publish:(value:{preference:AppearancePreference;resolved:ResolvedAppearance})=>void;}
export function createAppearanceController(options:Options){
 let preference:AppearancePreference='system';let disposed=false;
 try{preference=normalizeAppearance(options.read());}catch{/* Storage is optional. */}
 const publish=()=>{if(!disposed)options.publish({preference,resolved:preference==='system'?(options.isSystemDark()?'dark':'light'):preference});};
 const stop=options.subscribeSystem(()=>{if(preference==='system')publish();});publish();
 return {setPreference(value:AppearancePreference){preference=normalizeAppearance(value);try{options.write(preference);}catch{/* Keep the in-session choice. */}publish();},refresh(){try{preference=normalizeAppearance(options.read());}catch{}publish();},dispose(){disposed=true;stop();}};
}
