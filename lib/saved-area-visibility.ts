import type {FilterSpecification} from 'maplibre-gl';
import type {Visit} from './model';
interface PaintTarget{setFilter:(layer:string,filter:FilterSpecification)=>unknown;}
/** Hide removed polygons at the next render, independently of asynchronous GeoJSON worker updates. */
export function syncSavedAreaVisibility(map:PaintTarget,visits:Pick<Visit,'region'>[]):void{
 const ids=[...new Set(visits.map(v=>v.region.id))];
 const filter:FilterSpecification=['in',['get','id'],['literal',ids]];
 for(const layer of ['saved-area-fill','saved-area-glow','saved-area-border'])map.setFilter(layer,filter);
}
