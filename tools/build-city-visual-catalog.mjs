#!/usr/bin/env node
/** One to eight sequential city-detail jobs; never a hidden whole-city rebuild. */
import { readFile } from 'node:fs/promises';
import { dirname,resolve,join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setPriority,constants } from 'node:os';
import { buildCityVisualCatalog } from './visual/catalog-builder.mjs';
import { planCatalogJobs } from './visual/catalog-planner.mjs';
import { readCatalogOwnershipIndex,selectDistrictSampleJobs } from './visual/catalog-source-index.mjs';
import { preflightCatalogRun } from './visual/catalog-run-budget.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),args=process.argv.slice(2),options={root};
const flags=new Set(['--out','--max-jobs','--partition-zoom','--material-kit','--focus','--cell','--plan-only','--all']);
let planOnly=false,compileAll=false;
for(let i=0;i<args.length;i++){
  const flag=args[i];if(!flags.has(flag))throw new Error(`Unknown catalog option: ${flag}`);
  if(flag==='--plan-only'){planOnly=true;continue;}
  if(flag==='--all'){compileAll=true;continue;}
  const value=args[++i];if(!value||value.startsWith('--'))throw new Error(`Missing catalog option value: ${flag}`);
  if(flag==='--out')options.outputRoot=resolve(root,value);
  if(flag==='--max-jobs')options.maxJobs=Number(value);
  if(flag==='--partition-zoom')options.partitionZoom=Number(value);
  if(flag==='--material-kit')options.materialKit=value;
  if(flag==='--cell')options.cellKey=value;
  if(flag==='--focus'){options.focus=value.split(',').map(Number);if(options.focus.length!==2||!options.focus.every(Number.isFinite))throw new Error('Invalid focus coordinate');}
}
try{setPriority(0,constants.priority.PRIORITY_BELOW_NORMAL);}catch{/* One sequential bounded process remains the execution policy. */}
if(planOnly){
  const source=JSON.parse(await readFile(join(root,'apps/web/public/city-v2/manifest.json'))),jobs=planCatalogJobs(source,options);
  const ownership=await readCatalogOwnershipIndex(join(root,'apps/web/public/city-v2'),source,jobs);
  console.log(JSON.stringify({sourceCells:source.cells.length,sourceDistrictIds:source.coverage.districtIds,plannedCells:jobs.length,
    runtimeCatalogAdmitted:jobs.length<=4096,uniqueCanonicalBuildings:ownership.uniqueBuildings,sourceIndexSha256:ownership.sourceIndexSha256,
    emptyOwnershipJobs:[...ownership.owners.values()].filter(owner=>owner.ids.length===0).length,
    districtSamples:selectDistrictSampleJobs(ownership,jobs,source.coverage.districtIds),
    manifestEmptyJobs:jobs.filter(j=>j.sourceBuildingRows===0).length,maxSourceCells:Math.max(...jobs.map(j=>j.sourceCells.length)),
    maxSourceBytes:Math.max(...jobs.map(j=>j.sourceBytes)),maxBuildingRows:Math.max(...jobs.map(j=>j.sourceBuildingRows)),compiledJobs:0}));
}else{
  if(compileAll){
    if(options.maxJobs!==undefined||options.cellKey)throw new Error('--all cannot be combined with --max-jobs or --cell');
    const budget=await preflightCatalogRun(options);options.compileAll=true;options.outputBudgetBytes=budget.outputBudgetBytes;
    console.log(JSON.stringify({event:'complete_city_preflight',...budget}));
  }
  const started=performance.now();let lastReported=0;
  options.onProgress=progress=>{
    const elapsedSeconds=(performance.now()-started)/1000;
    if(!compileAll||progress.compiled%25===0||elapsedSeconds-lastReported>=45||progress.finishedJobs===progress.plannedJobs){
      console.log(JSON.stringify({...progress,elapsedSeconds}));lastReported=elapsedSeconds;
    }
  };
  console.log(JSON.stringify((await buildCityVisualCatalog(options)).report));
}
