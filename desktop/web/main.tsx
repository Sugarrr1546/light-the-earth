import { createRoot } from 'react-dom/client';
import '../../app/globals.css';
import 'maplibre-gl/dist/maplibre-gl.css';
import AtlasApp from '../../components/AtlasApp';
import { LOCAL_USER_ID } from '../../lib/local-api';

createRoot(document.getElementById('root')!).render(<AtlasApp userId={LOCAL_USER_ID} />);
