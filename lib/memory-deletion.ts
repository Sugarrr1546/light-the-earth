import type {Visit} from './model';
interface Options{remove:(id:string)=>Promise<unknown>;onDeleted:(id:string)=>void;}
/** Permanently delete on the server, then update the current page without a recovery timer. */
export async function deleteMemory(visit:Visit,options:Options):Promise<void>{
 const id=visit.id;
 await options.remove(id);
 options.onDeleted(id);
}
