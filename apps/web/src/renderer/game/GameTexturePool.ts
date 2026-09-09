import {CanvasTexture,Mesh,Texture,type Object3D} from 'three';

/** One bounded material kit per city renderer. Tile eviction cannot dispose it. */
export class GameTexturePool {
  private readonly entries=new Map<string,Promise<Texture>>();
  private readonly owned=new Set<Texture>();
  private retainedBytes=0;
  private disposed=false;
  constructor(private readonly options:{maxBytes:number;maxTextures?:number}){}
  get bytes(){return this.retainedBytes;}
  get count(){return this.entries.size;}
  acquire(key:string,load:()=>Promise<Texture>):Promise<Texture>{
    if(this.disposed)return Promise.reject(new Error('City texture pool disposed'));
    const prior=this.entries.get(key);if(prior)return prior;
    if(this.entries.size>=(this.options.maxTextures??64))return Promise.reject(new Error('City texture count budget exceeded'));
    const promise=load().then(texture=>{
      if(!texture?.isTexture)throw new Error('City texture decode failed');
      const image=texture.image as {width:number;height:number};
      const bytes=Math.ceil(image.width*image.height*4*(1+4/3)); // retained pixels + GPU mip chain
      if(this.disposed||!Number.isSafeInteger(bytes)||bytes<1||this.retainedBytes+bytes>this.options.maxBytes){
        release(texture);throw new Error('City texture memory budget exceeded');
      }
      this.retainedBytes+=bytes;this.owned.add(texture);
      // The shared kit, not an individual parsed GLB, owns these resources.
      // Use a canvas image so an aborted tile cannot close a shared ImageBitmap.
      texture.dispose=()=>{};
      return texture;
    }).catch(error=>{this.entries.delete(key);throw error;});
    this.entries.set(key,promise);return promise;
  }
  dispose(){if(this.disposed)return;this.disposed=true;for(const texture of this.owned)release(texture);this.owned.clear();this.entries.clear();this.retainedBytes=0;}
}
function release(texture:Texture){
  Texture.prototype.dispose.call(texture);
  if(typeof OffscreenCanvas!=='undefined'&&texture.image instanceof OffscreenCanvas){texture.image.width=1;texture.image.height=1;}
}

/** Decode source bytes unchanged; choose bounded display resolution per quality. */
export function retainTextureAtResolution(source:Texture,size:number):Texture{
  if(!source?.isTexture)throw new Error('City texture decode failed');
  const image=source.image as ImageBitmap;
  const scale=Math.min(1,size/Math.max(image.width,image.height));
  const canvas=new OffscreenCanvas(Math.max(1,Math.round(image.width*scale)),Math.max(1,Math.round(image.height*scale)));
  const context=canvas.getContext('2d');if(!context)throw new Error('City texture staging canvas unavailable');
  context.drawImage(image,0,0,canvas.width,canvas.height);
  const texture=new CanvasTexture(canvas);
  texture.flipY=source.flipY;texture.wrapS=source.wrapS;texture.wrapT=source.wrapT;
  texture.magFilter=source.magFilter;texture.minFilter=source.minFilter;
  texture.colorSpace=source.colorSpace;texture.name=source.name;
  source.dispose();image.close?.();
  return texture;
}

/** Conservative retained CPU attributes + their GPU copies; textures counted once by pool. */
export function geometryResidentBytes(scene:Object3D):number{
  const arrays=new Set<ArrayBufferLike>();let bytes=0;
  const retain=(array:{buffer:ArrayBufferLike})=>{if(!arrays.has(array.buffer)){arrays.add(array.buffer);bytes+=array.buffer.byteLength;}};
  scene.traverse(object=>{
    const mesh=object as Mesh;if(!mesh.geometry)return;
    for(const attribute of Object.values(mesh.geometry.attributes))retain('data' in attribute?attribute.data.array:attribute.array);
    if(mesh.geometry.index)retain(mesh.geometry.index.array);
  });
  return bytes*2;
}
