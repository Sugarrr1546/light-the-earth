'use client';
import {useCallback,useEffect,useRef,useState}from'react';
import {DEFAULT_MAP_PANELS,MAP_PANELS_KEY,readMapPanels,type MapPanels}from'./map-view-controls';
export function useMapPanels(){
 const [panels,setPanels]=useState<MapPanels>(DEFAULT_MAP_PANELS);
 const current=useRef(panels);
 useEffect(()=>{let next={...DEFAULT_MAP_PANELS};try{next=readMapPanels(localStorage.getItem(MAP_PANELS_KEY));}catch{/* Storage may be unavailable. */}current.current=next;setPanels(next);},[]);
 const setPanel=useCallback((key:keyof MapPanels,visible:boolean)=>{const next={...current.current,[key]:visible};current.current=next;setPanels(next);try{localStorage.setItem(MAP_PANELS_KEY,JSON.stringify(next));}catch{/* Current-session controls remain available. */}},[]);
 return {panels,setPanel};
}
