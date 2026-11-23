import type {Feature,FeatureCollection,Geometry} from 'geojson';
type CountyFeature=Feature<Geometry>;
interface CountyDiff {remove:(string|number)[];add:CountyFeature[];}
interface Options {
 initial?:FeatureCollection;
 apply:(diff:CountyDiff)=>Promise<unknown>;
 onError?:(error:unknown,latest:FeatureCollection)=>void;
 yieldTask?:()=>Promise<void>;
 limit?:number;
}
/** Transfer every exact commune, without one recursively cloned country-sized message. */
export function createCountySourceUpdates({initial,apply,onError,yieldTask=()=>new Promise(resolve=>setTimeout(resolve,0)),limit=2048}:Options){
 if(!Number.isSafeInteger(limit)||limit<1)throw Error('Invalid county update batch size');
 const current=new Map<string|number,CountyFeature>(initial?.features.map(feature=>[feature.id!,feature])??[]);
 let desired:{data:FeatureCollection;byId:Map<string|number,CountyFeature>}|null=null;
 let running:Promise<void>|null=null,disposed=false,failed=false,latest:FeatureCollection|null=null;
 function fail(error:unknown){
  if(disposed||failed||!latest)return false;
  failed=true;desired=null;onError?.(error,latest);return true;
 }
 async function run(){
  try{
   while(!disposed&&!failed&&desired){
    const target=desired,remove:CountyDiff['remove']=[],add:CountyDiff['add']=[];
    for(const id of current.keys())if(!target.byId.has(id)){remove.push(id);if(remove.length===limit)break;}
    if(remove.length<limit)for(const [id,feature]of target.byId){
     const prior=current.get(id);
     if(!prior||prior.geometry!==feature.geometry||prior.properties!==feature.properties){add.push(feature);if(remove.length+add.length===limit)break;}
    }
    if(!remove.length&&!add.length){if(desired===target)desired=null;continue;}
    await apply({remove,add});
    if(disposed||failed)return;
    for(const id of remove)current.delete(id);
    for(const feature of add)current.set(feature.id!,feature);
    await yieldTask();
   }
  }catch(error){
   fail(error);
  }
 }
 function start():Promise<void>{
  if(!running)running=Promise.resolve().then(run).finally(()=>{running=null;if(desired&&!disposed)return start();});
  return running;
 }
 return {
  update(data:FeatureCollection):Promise<void>{
   if(disposed)return Promise.resolve();
   latest=data;
   if(failed){onError?.(new Error('County incremental source unavailable'),data);return Promise.resolve();}
   const byId=new Map<string|number,CountyFeature>();
   for(const feature of data.features){if(feature.id==null||byId.has(feature.id))throw Error('County updates require unique feature IDs');byId.set(feature.id,feature);}
   desired={data,byId};
   return start();
  },
  fail,
  dispose(){disposed=true;desired=null;latest=null;current.clear();},
 };
}
/** Other countries retain the measured v20 source delivery path. */
export function usesCountySourceUpdates(countryCode:string){return countryCode==='FRA';}
