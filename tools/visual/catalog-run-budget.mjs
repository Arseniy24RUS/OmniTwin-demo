import { mkdir,realpath,statfs } from 'node:fs/promises';
import { join,resolve,relative,isAbsolute,sep,dirname } from 'node:path';

export const CITY_CATALOG_OUTPUT_BUDGET_BYTES=20*1024**3;
export function assertCatalogRunBudget({availableBytes,outputBudgetBytes=CITY_CATALOG_OUTPUT_BUDGET_BYTES,workingReserveBytes=2*1024**3}) {
  if(!Number.isSafeInteger(outputBudgetBytes)||outputBudgetBytes<1||outputBudgetBytes>CITY_CATALOG_OUTPUT_BUDGET_BYTES
    ||!Number.isSafeInteger(workingReserveBytes)||workingReserveBytes<0)throw new Error('Invalid complete catalog output budget');
  if(!Number.isSafeInteger(availableBytes)||availableBytes<0)throw new Error('Invalid available catalog disk space');
  if(availableBytes<outputBudgetBytes+workingReserveBytes)throw new Error('Insufficient free space for catalog output budget and working reserve');
  return {outputBudgetBytes,workingReserveBytes,availableBytes};
}
function inside(root,path){const part=relative(root,path);return part&&part!=='..'&&!part.startsWith(`..${sep}`)&&!isAbsolute(part);}

/** Checks the workspace cache volume, rejecting junction escapes before any complete-city output. */
export async function preflightCatalogRun({root,outputRoot,outputBudgetBytes=CITY_CATALOG_OUTPUT_BUDGET_BYTES}) {
  const repository=await realpath(root),cache=join(repository,'.cache'),output=resolve(outputRoot??join(cache,'city-visual-catalog-v1'));
  if(!inside(cache,output))throw new Error('Complete catalog output must be inside the workspace cache');
  await mkdir(cache,{recursive:true});
  if(!inside(repository,await realpath(cache)))throw new Error('Workspace cache resolves outside repository');
  let parent=output;
  while(true){
    try{const actual=await realpath(parent);if(actual!==cache&&!inside(cache,actual))throw new Error('Catalog output resolves outside workspace cache');break;}
    catch(error){if(error.code!=='ENOENT')throw error;parent=dirname(parent);}
  }
  const volume=await statfs(cache),availableBytes=Number(volume.bavail)*Number(volume.bsize);
  return {...assertCatalogRunBudget({availableBytes,outputBudgetBytes}),outputRoot:output};
}
