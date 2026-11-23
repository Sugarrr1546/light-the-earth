export const MAP_PANELS_KEY='atlas-map-panels-v1';
export interface MapPanels {search:boolean;timeline:boolean;sidebar:boolean;hints:boolean;}
export const DEFAULT_MAP_PANELS:MapPanels={search:true,timeline:true,sidebar:true,hints:true};
export function readMapPanels(raw:string|null):MapPanels {
 const result={...DEFAULT_MAP_PANELS};
 try{const saved:unknown=JSON.parse(raw??'null');if(saved&&typeof saved==='object')for(const key of Object.keys(result)as(keyof MapPanels)[])if(typeof(saved as MapPanels)[key]==='boolean')result[key]=(saved as MapPanels)[key];}catch{/* Optional device preferences. */}
 return result;
}
export interface StarfieldCamera {lng:number;lat:number;x:number;y:number;}
/** Integrate the shortest camera longitude change, so crossing the date line never jumps. */
export function advanceStarfield(previous:StarfieldCamera,lng:number,lat:number,reducedMotion:boolean):StarfieldCamera {
 const delta=((lng-previous.lng+180)%360+360)%360-180;
 return {lng,lat,x:previous.x+(reducedMotion?0:delta*1.1),y:previous.y+(reducedMotion?0:(lat-previous.lat)*1.4)};
}
/** Searched places keep some city context: back off the tight fit and stop short of street level,
 * but never back off across the zoom where neighbouring local boundaries appear. */
export const LOCAL_FOCUS_MAX_ZOOM=11;
export function localFocusZoom(fitZoom:number,detailMinZoom:number):number {
 return Math.max(Math.min(fitZoom-0.6,LOCAL_FOCUS_MAX_ZOOM),Math.min(fitZoom,detailMinZoom+0.1));
}
/** Saved areas pulse only when a save asked for it; areas re-shown by a filter or tab stay quiet.
 * Returns the requested ids now on the map and forgets them, along with stale requests. */
export function claimPulses(pending:Map<string,number>,present:Iterable<string>,now:number,ttl=15000):string[]{
 for(const [id,requested] of pending)if(now-requested>ttl)pending.delete(id);
 const claimed:string[]=[];
 for(const id of present)if(pending.delete(id))claimed.push(id);
 return claimed;
}
/** Camera padding that centres the view in the part of the map no panel covers. */
export function mapPadding(width:number,sidebarVisible:boolean,bottomInset:number,topInset=0){
 return {left:width>900&&sidebarVisible?(width<=1190?310:340):0,right:0,top:Math.max(0,Math.round(topInset)),bottom:Math.max(0,Math.round(bottomInset))};
}
/** Diameter of the overview globe that fits the height left between the toolbar and the bottom panels. */
export function overviewDiameter(width:number,height:number,bottomInset:number,topInset=0):number{
 const free=Math.max(0,height-Math.max(0,bottomInset)-Math.max(0,topInset));
 return width>=900?Math.min(600,free*0.8,(width-300)*0.8):Math.min(440,free*0.62,width*0.88);
}
/** Horizontal pan that keeps a clicked point clear of the detail drawer; 0 leaves the camera alone. */
export function drawerRevealShift(x:number,width:number,drawerInset:number,margin=48):number {
 const limit=width-drawerInset-margin;
 return x>limit?x-limit:0;
}
