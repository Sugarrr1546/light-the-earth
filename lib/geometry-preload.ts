export interface PreloadProgress{code:string;done:number;total:number;}
interface Options{load:(code:string,signal:AbortSignal,onProgress:(done:number,total:number)=>void)=>Promise<void>;publish:(progress:PreloadProgress|null)=>void;retryDelay?:number;}
/** One background country at a time; its assets share a foreground-priority reader pool. */
export function createGeometryPreloader({load,publish,retryDelay=60000}:Options){
 const complete=new Set<string>(),failed=new Map<string,number>();let queue:string[]=[];let current:{code:string;abort:AbortController}|null=null;let disposed=false;
 function pump(){if(disposed||current)return;const code=queue.shift();if(!code)return;const job={code,abort:new AbortController()};current=job;
  void(async()=>{try{await load(code,job.abort.signal,(done,total)=>{if(!disposed&&!job.abort.signal.aborted)publish({code,done,total});});if(!disposed&&!job.abort.signal.aborted){complete.add(code);failed.delete(code);}}catch{if(!disposed&&!job.abort.signal.aborted)failed.set(code,Date.now());}finally{if(current===job)current=null;if(!disposed){publish(null);pump();}}})();
 }
 return{setTargets(codes:string[]){if(disposed)return;queue=[...new Set(codes)].filter(code=>code!==current?.code&&!complete.has(code)&&Date.now()-(failed.get(code)??-Infinity)>=retryDelay);pump();},dispose(){disposed=true;queue=[];current?.abort.abort();current=null;}};
}
