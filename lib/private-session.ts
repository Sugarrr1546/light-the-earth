export class SessionChangedError extends Error {
  readonly code='ACCOUNT_CHANGED';
  constructor(){super('登录状态已变化，请重新登录后继续。');}
}
type Scope={actor:string;active:boolean;onInvalidated:()=>void};
let current:Scope|undefined;
export function bindPrivateSession(actor:string,onInvalidated:()=>void){
 const previous=current;
 if(previous)previous.active=false;
 const scope:Scope={actor,active:true,onInvalidated};current=scope;
 return()=>{scope.active=false;if(current===scope)current=undefined;};
}
export function privateSessionLease(expectedActor?:string){
 const scope=current;
 const assert=()=>{if(!scope?.active||current!==scope||(expectedActor!==undefined&&expectedActor!==scope.actor))throw new SessionChangedError();};
 assert();
 return {actor:scope!.actor,assert,invalidate(){if(!scope?.active||current!==scope)return;scope.active=false;scope.onInvalidated();}};
}
export async function verifyPrivateSession(fetcher:typeof fetch=fetch){
 const lease=privateSessionLease();
 try{
  const response=await fetcher('/api/session',{cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(10000)});
  if(!response.ok){if(response.status===401||response.status===403)lease.invalidate();return false;}
  const data=await response.json() as {userId?:string|null};lease.assert();
  if(data.userId!==lease.actor){lease.invalidate();return false;}return true;
 }catch(error){if(error instanceof SessionChangedError)return false;/* A transient network failure does not switch identity. */return false;}
}

/** Synchronous curtain for BFCache/blur, with one event-driven probe at a time. */
export function createPrivateVisibilityGuard(options:{hide:()=>void;show:()=>void;failed:()=>void;canShow:()=>boolean;verify:()=>Promise<boolean>}){
 let generation=0,checking=false,disposed=false;
 const hide=()=>{if(disposed)return;generation++;options.hide();};
 const check=()=>{
  if(disposed||checking||!options.canShow())return;
  hide();const started=generation;checking=true;
  void options.verify().then(valid=>{if(disposed||started!==generation)return;if(valid&&options.canShow())options.show();else options.failed();}).catch(()=>{if(!disposed&&started===generation)options.failed();}).finally(()=>{checking=false;if(!disposed&&started!==generation&&options.canShow())check();});
 };
 return {hide,check,dispose(){disposed=true;generation++;}};
}
