import type {Feature, FeatureCollection, Polygon, MultiPolygon} from 'geojson';
import type {Region, Visit, VisitStatus} from './model';
type Area = Feature<Polygon|MultiPolygon>;
interface Options {
  load: (code:string,signal:AbortSignal,ids:string[])=>Promise<FeatureCollection<Polygon|MultiPolygon>>;
  countries?: Area[];
  refineCountryIds?: Set<string>;
  publish: (areas:FeatureCollection<Polygon|MultiPolygon>)=>void;
  onError?: (code:string)=>void;
}
const priority:Record<VisitStatus,number>={wishlist:0,passed:1,visited:2,lived:3};
function polygonArea(geometry:Polygon|MultiPolygon):number {
  const polygons=geometry.type==='Polygon'?[geometry.coordinates]:geometry.coordinates;
  return polygons.reduce((total,rings)=>total+rings.reduce((area,ring,index)=>{
    let twice=0;for(let i=0;i<ring.length-1;i++)twice+=ring[i][0]*ring[i+1][1]-ring[i+1][0]*ring[i][1];
    return area+(index===0?1:-1)*Math.abs(twice)/2;
  },0),0);
}
/** Keep only saved polygons, independently of the six-country exploration cache. */
export function createVisitedAreaLoader(options:Options) {
  const countries=new Map((options.countries??[]).map(f=>[String(f.id??f.properties?.id),f]));
  const cache=new Map<string,Area>();
  const refined=new Set<string>();
  const failed=new Set<string>();
  const batchSize=8;
  const jobs=new Map<string,{abort:AbortController;ids:string[]}>();
  let wanted=new Map<string,{region:Region;status:VisitStatus}>();
  let queued:string[]=[];let disposed=false;let visitsInitialized=false;
  const areas=new WeakMap<Polygon|MultiPolygon,number>();
  const areaOf=(geometry:Polygon|MultiPolygon)=>{let value=areas.get(geometry);if(value===undefined){value=polygonArea(geometry);areas.set(geometry,value);}return value;};
  function publish() {
    if(disposed)return;
    const features:Area[]=[];
    // Country memories form the background; local memories remain visible above them.
    const entries=[...wanted].sort(([,a],[,b])=>Number(a.region.level==='local')-Number(b.region.level==='local'));
    for(const [id,visit] of entries){
      const feature=cache.get(id)??countries.get(id);
      if(feature)features.push({...feature,id,properties:{...visit.region,status:visit.status}});
    }
    features.sort((a,b)=>Number(a.properties?.level==='local')-Number(b.properties?.level==='local')||areaOf(b.geometry)-areaOf(a.geometry));
    features.forEach((feature,index)=>{feature.properties!.paintOrder=index;});
    options.publish({type:'FeatureCollection',features});
  }
  const pendingIds=(code:string)=>[...wanted].filter(([id,visit])=>visit.region.countryCode===code&&!refined.has(id)&&!failed.has(id)&&(!countries.has(id)||options.refineCountryIds?.has(id))).map(([id])=>id);
  function pump() {
    while(!disposed&&jobs.size<2&&queued.length){
      const code=queued.shift()!;if(jobs.has(code))continue;
      const ids=pendingIds(code).slice(0,batchSize);
      if(!ids.length)continue;
      const abort=new AbortController();const job={abort,ids};jobs.set(code,job);
      void (async()=>{
        try{
          const data=await options.load(code,abort.signal,ids);
          if(disposed||abort.signal.aborted)return;
          for(const feature of data.features){
            const id=String(feature.id??feature.properties?.id??'');
            if(ids.includes(id)&&!refined.has(id)&&wanted.get(id)?.region.countryCode===code&&['Polygon','MultiPolygon'].includes(feature.geometry?.type)){cache.set(id,feature);refined.add(id);}
          }
          const missing=ids.filter(id=>!refined.has(id));for(const id of missing)failed.add(id);
          if(missing.length)options.onError?.(code);
          publish();
        }catch{
          if(!disposed&&!abort.signal.aborted){for(const id of ids)failed.add(id);options.onError?.(code);}
        }finally{
          if(jobs.get(code)===job)jobs.delete(code);
          if(!disposed&&pendingIds(code).length&&!queued.includes(code))queued.push(code);
          pump();
        }
      })();
    }
  }
  return {
    setVisits(visits:Pick<Visit,'region'|'status'>[]) {
      if(disposed)return;
      const next=new Map<string,{region:Region;status:VisitStatus}>();
      for(const visit of visits){const old=next.get(visit.region.id);if(!old||priority[visit.status]>priority[old.status])next.set(visit.region.id,visit);}
      if(visitsInitialized&&!failed.size&&next.size===wanted.size&&[...next].every(([id,v])=>wanted.get(id)?.region===v.region&&wanted.get(id)?.status===v.status))return;
      visitsInitialized=true;wanted=next;failed.clear();
      for(const id of cache.keys())if(!wanted.has(id)){cache.delete(id);refined.delete(id);}
      const needed=new Map<string,string[]>();
      for(const [id,visit] of wanted)if(!refined.has(id)&&(!countries.has(id)||options.refineCountryIds?.has(id))){const ids=needed.get(visit.region.countryCode)??[];ids.push(id);needed.set(visit.region.countryCode,ids);}
      for(const [code,job] of jobs){const ids=needed.get(code);if(!ids||job.ids.some(id=>!ids.includes(id))){job.abort.abort();jobs.delete(code);}}
      queued=[...needed.keys()].filter(code=>!jobs.has(code));
      publish();pump();
    },
    prime(features:Area[],quality:'primary'|'display'='primary'){
      if(disposed)return;
      let changed=false;
      for(const feature of features){const id=String(feature.id??feature.properties?.id??'');if(wanted.has(id)&&cache.get(id)?.geometry!==feature.geometry&&(quality==='primary'||!refined.has(id))){cache.set(id,feature);if(quality==='primary')refined.add(id);changed=true;}if(wanted.has(id)&&quality==='primary')refined.add(id);}
      if(changed)publish();
    },
    dispose(){disposed=true;for(const job of jobs.values())job.abort.abort();jobs.clear();queued=[];cache.clear();refined.clear();failed.clear();wanted.clear();},
  };
}
