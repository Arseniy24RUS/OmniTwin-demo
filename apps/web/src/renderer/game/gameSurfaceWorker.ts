import {GameSurfaceWorkerCore} from './GameSurfaceWorkerCore';
import {gameSurfaceTransferables,type GameSurfaceResponse} from './gameSurfaceProtocol';

// No timer, RAF, rendering context or mutable source cache. One Worker lives for
// the Layer lifetime; the main client bounds and coalesces its message queue.
const scope=globalThis as unknown as {onmessage:((event:MessageEvent<unknown>)=>void)|null;postMessage:(message:GameSurfaceResponse,transfer:ArrayBuffer[])=>void};
const core=new GameSurfaceWorkerCore();
scope.onmessage=event=>{const result=core.handle(event.data);scope.postMessage(result,gameSurfaceTransferables(result));};
