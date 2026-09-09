#!/usr/bin/env node
import {resolve,relative,sep} from 'node:path';
import {setPriority,constants} from 'node:os';
import {refinalizeCityCatalog} from './visual/catalog-refinalize.mjs';
const root=resolve(import.meta.dirname,'..'),args=process.argv.slice(2),options={root};
for(let i=0;i<args.length;i++){
 const flag=args[i],value=args[++i];if(!['--catalog','--expected-sha','--out'].includes(flag)||!value||value.startsWith('--'))throw Error('Expected --catalog, --expected-sha and --out');
 const key={'--catalog':'inputCatalog','--expected-sha':'expectedCatalogSha256','--out':'outputRoot'}[flag];if(options[key])throw Error('Duplicate metadata option');options[key]=key==='expectedCatalogSha256'?value:resolve(root,value);
}
if(!options.inputCatalog||!options.expectedCatalogSha256||!options.outputRoot)throw Error('All metadata finalization arguments required');
try{setPriority(0,constants.priority.PRIORITY_BELOW_NORMAL);}catch{/* Sequential bounded I/O remains the policy. */}
const start=performance.now();options.onProgress=p=>{if(p.completedCells%100===0||p.completedCells===p.totalCells)console.log(JSON.stringify({...p,elapsedSeconds:(performance.now()-start)/1000}));};
const {catalog,...result}=await refinalizeCityCatalog(options);
for(const key of ['catalogFile','buildRoot'])result[key]=relative(root,result[key]).split(sep).join('/');
console.log(JSON.stringify({...result,coverage:catalog.coverage,elapsedSeconds:(performance.now()-start)/1000,publicChanged:false}));
