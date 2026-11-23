import {rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
// Repeated builds must not retain stale/duplicate generated static assets.
// Resolve from this script so invoking it in another cwd cannot remove user data.
await rm(fileURLToPath(new URL('../dist/',import.meta.url)),{recursive:true,force:true});
