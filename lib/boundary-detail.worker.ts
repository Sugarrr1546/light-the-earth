import type { Feature, FeatureCollection, Polygon, MultiPolygon } from 'geojson';
import { boxesOverlap, type ViewBox } from './county-layer';

const generations=new Map<string,number>();
const loaded = new Map<string, Feature<Polygon | MultiPolygon>[]>();

async function decode(buffer: ArrayBuffer): Promise<FeatureCollection> {
  let bytes = new Uint8Array(buffer);
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
  }
  if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('边界文件超过解压大小限制');
  const parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as FeatureCollection;
  if (parsed?.type !== 'FeatureCollection' || !Array.isArray(parsed.features)) throw new Error('边界数据格式无效');
  return parsed;
}

self.onmessage = (event: MessageEvent<{ type: 'load' | 'view' | 'drop'; id: number; key: string; buffer?: ArrayBuffer; view?: ViewBox; extraIds?: string[] }>) => {
  const message = event.data;
  void (async () => {
    try {
      if (message.type === 'drop') { generations.set(message.key,(generations.get(message.key)??0)+1);loaded.delete(message.key); return; }
      if (message.type === 'load') {
        const generation=(generations.get(message.key)??0)+1;generations.set(message.key,generation);
        const collection = await decode(message.buffer ?? new ArrayBuffer(0));
        if(generations.get(message.key)!==generation){self.postMessage({type:'error',id:message.id,key:message.key,message:'区域已移出视野'});return;}
        loaded.set(message.key, collection.features.filter((feature): feature is Feature<Polygon | MultiPolygon> => feature.geometry?.type === 'Polygon' || feature.geometry?.type === 'MultiPolygon'));
        self.postMessage({ type: 'loaded', id: message.id, key: message.key });
        return;
      }
      const features = loaded.get(message.key);
      if (!features || !message.view) throw new Error('精细边界尚未就绪');
      const visible = features.filter((feature) => {
        const id = String(feature.id ?? (feature.properties as { id?: string } | null)?.id ?? '');
        if (message.extraIds?.includes(id)) return true;
        const box = (feature.properties as { bbox?: ViewBox } | null)?.bbox;
        return !box || box.length !== 4 || boxesOverlap(box, message.view as ViewBox);
      });
      self.postMessage({ type: 'view', id: message.id, key: message.key, features: visible });
    } catch (error) {
      self.postMessage({ type: 'error', id: message.id, key: message.key, message: error instanceof Error ? error.message : '精细边界解析失败' });
    }
  })();
};
