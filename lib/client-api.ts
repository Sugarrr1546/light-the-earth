import {privateSessionLease} from './private-session';
export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message:string,status:number,code?:string){super(message);this.status=status;this.code=code;}
}

export async function privateFetch(path:string,options:RequestInit={}){
  const lease=privateSessionLease();
  const headers=new Headers(options.headers);
  if(!(options.body instanceof FormData)&&!headers.has('Content-Type'))headers.set('Content-Type','application/json');
  headers.set('x-atlas-actor',lease.actor);
  const response=await fetch(path,{...options,headers,cache:'no-store',credentials:'same-origin'});
  lease.assert();
  if(response.status===401){lease.invalidate();throw new ApiError('请登录后再保存旅行记录',401,'ACCOUNT_CHANGED');}
  if(response.status===403){const error=await response.clone().json().catch(()=>null) as {code?:string}|null;lease.assert();if(error?.code==='ACCOUNT_CHANGED'){lease.invalidate();throw new ApiError('登录账号已变化，请重新登录后继续。',403,'ACCOUNT_CHANGED');}}
  return response;
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const lease=privateSessionLease();
  const response=await privateFetch(path,options);
  const data = await response.json().catch(() => null) as {error?: string;code?:string} | null;
  lease.assert();
  if(response.status===403&&data?.code==='ACCOUNT_CHANGED'){lease.invalidate();throw new ApiError('登录账号已变化，请重新登录后继续。',403,'ACCOUNT_CHANGED');}
  if (!response.ok) throw new ApiError(data?.error || '暂时无法连接，请稍后重试',response.status,data?.code);
  return data as T;
}

export async function preparePhoto(file: File): Promise<File> {
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) throw new Error('请选择 JPG、PNG 或 WebP 照片');
  if (file.size > 25 * 1024 * 1024) throw new Error('单张原始照片请小于 25 MB');
  const bitmap = await createImageBitmap(file);
  try {
    const ratio = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * ratio));
    canvas.height = Math.max(1, Math.round(bitmap.height * ratio));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法处理这张照片');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => b ? resolve(b) : reject(new Error('照片处理失败')), 'image/jpeg', 0.86));
    return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', {type:'image/jpeg'});
  } finally { bitmap.close(); }
}
