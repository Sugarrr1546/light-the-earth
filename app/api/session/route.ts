import {getChatGPTUser} from '@/app/chatgpt-auth';
import {json} from '../_shared';
export const dynamic='force-dynamic';
export async function GET(){const user=await getChatGPTUser();return json({userId:user?.userId??null});}
