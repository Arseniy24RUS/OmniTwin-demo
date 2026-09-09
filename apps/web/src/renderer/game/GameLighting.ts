import {DataTexture,EquirectangularReflectionMapping,RGBAFormat,SRGBColorSpace} from 'three';

/** Small authored sky/ground environment. Visual synthesis, independent of observed weather. */
export function createGameEnvironment():DataTexture{
  const width=128,height=64,pixels=new Uint8Array(width*height*4);
  for(let y=0;y<height;y++){
    const elevation=Math.cos((y+.5)/height*Math.PI);
    const horizon=Math.exp(-Math.abs(elevation)*8);
    const sky=elevation>=0;
    const top=sky?[139,169,187]:[71,73,63],edge=sky?[225,217,195]:[147,140,115];
    for(let x=0;x<width;x++){const at=(y*width+x)*4;
      for(let c=0;c<3;c++)pixels[at+c]=Math.round(top[c]!*(1-horizon)+edge[c]!*horizon);
      pixels[at+3]=255;
    }
  }
  const texture=new DataTexture(pixels,width,height,RGBAFormat);
  texture.mapping=EquirectangularReflectionMapping;texture.colorSpace=SRGBColorSpace;
  texture.needsUpdate=true;texture.name='authored-daylight-environment-visual-synthesis';
  return texture;
}
