'use client';
import {useEffect,useRef,useState} from 'react';
import {APPEARANCE_KEY,createAppearanceController,type AppearancePreference,type ResolvedAppearance} from './appearance';
export function useAppearance(){
 const [appearance,setAppearance]=useState<{preference:AppearancePreference;resolved:ResolvedAppearance}>({preference:'system',resolved:'dark'});
 const controller=useRef<ReturnType<typeof createAppearanceController>|null>(null);
 useEffect(()=>{
  const media=window.matchMedia('(prefers-color-scheme: dark)');
  const current=createAppearanceController({read:()=>localStorage.getItem(APPEARANCE_KEY),write:value=>localStorage.setItem(APPEARANCE_KEY,value),isSystemDark:()=>media.matches,subscribeSystem:fn=>{media.addEventListener('change',fn);return()=>media.removeEventListener('change',fn);},publish:value=>{document.documentElement.dataset.theme=value.resolved;document.documentElement.dataset.appearance=value.preference;document.documentElement.style.colorScheme=value.resolved;setAppearance(value);}});
  controller.current=current;const storage=(event:StorageEvent)=>{if(event.key===APPEARANCE_KEY||event.key===null)current.refresh();};window.addEventListener('storage',storage);
  return()=>{current.dispose();controller.current=null;window.removeEventListener('storage',storage);};
 },[]);
 return {...appearance,setPreference:(value:AppearancePreference)=>controller.current?.setPreference(value)};
}
