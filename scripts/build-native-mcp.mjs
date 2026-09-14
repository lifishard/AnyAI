import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
await build({entryPoints:[root+'electron/native-mcp.cjs'],outfile:root+'electron/native-mcp.bundle.cjs',bundle:true,platform:'node',format:'cjs',target:'node20',minify:true,logLevel:'warning'});
