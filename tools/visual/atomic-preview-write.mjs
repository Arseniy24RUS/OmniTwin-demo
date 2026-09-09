import {rename} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

/** Replace an already verified generated manifest without an unlink/write gap.
 * Windows ReplaceFile handles existing destinations rejected by MoveFileEx. */
export async function replacePreviewManifest(from,to) {
  try{await rename(from,to);return 'rename';}
  catch(error){
    if(process.platform!=='win32'||!['EPERM','EACCES'].includes(error.code))throw error;
    await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',
      '[IO.File]::Replace($env:OMNITWIN_PREVIEW_FROM,$env:OMNITWIN_PREVIEW_TO,[System.Management.Automation.Language.NullString]::Value)'],
    {windowsHide:true,timeout:10000,env:{...process.env,OMNITWIN_PREVIEW_FROM:from,OMNITWIN_PREVIEW_TO:to}});
    return 'windows_replacefile';
  }
}
