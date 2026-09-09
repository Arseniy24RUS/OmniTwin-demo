import {createReadStream} from 'node:fs';
import {stat} from 'node:fs/promises';
import {resolve,sep} from 'node:path';

/** Development-only, narrowly scoped serving of the immutable movement preview. */
export function movementPreviewMiddleware(directory,base){
  const root=resolve(directory),prefix=`${base}movement-preview-v2/`;
  return (request,response,next)=>{
    if(!['GET','HEAD'].includes(request.method))return next();
    let pathname;try{pathname=decodeURIComponent(new URL(request.url,'http://localhost').pathname);}catch{return next();}
    if(!pathname.startsWith(prefix))return next();
    const relative=pathname.slice(prefix.length);
    if(!/^[a-zA-Z0-9_./-]+\.(?:json|bin|gz)$/.test(relative)||relative.split('/').includes('..')){
      response.statusCode=400;response.end();return;
    }
    const file=resolve(root,relative);
    if(!file.startsWith(`${root}${sep}`)){response.statusCode=400;response.end();return;}
    void stat(file).then(info=>{
      if(!info.isFile()){response.statusCode=404;response.end();return;}
      response.setHeader('Content-Type',relative.endsWith('.gz')?'application/gzip':relative.endsWith('.json')?'application/json':'application/octet-stream');
      response.setHeader('Content-Length',info.size);
      response.setHeader('Cache-Control',relative==='activation.json'?'no-store':'public, max-age=3600');
      response.removeHeader('Content-Encoding');
      if(request.method==='HEAD'){response.end();return;}
      const stream=createReadStream(file);stream.on('error',()=>response.destroy());response.on('close',()=>stream.destroy());stream.pipe(response);
    },()=>{response.statusCode=404;response.end();});
  };
}
