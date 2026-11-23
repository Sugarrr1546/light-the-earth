import AtlasApp from '../components/AtlasApp';
import { requireChatGPTUser } from './chatgpt-auth';
export const dynamic = 'force-dynamic';
export default async function Home() {
  const user = await requireChatGPTUser('/');
  return <AtlasApp key={user.userId} userId={user.userId}/>;
}
