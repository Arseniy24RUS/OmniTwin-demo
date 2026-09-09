/** WGS84 local tangent plane. East/north input basis; glTF uses east/up/south. */
const A=6378137,E2=6.6943799901413165e-3,RAD=Math.PI/180;
export function projectLocal(point,origin){
  const p=origin[1]*RAD,s=Math.sin(p),q=1-E2*s*s;
  return [(point[0]-origin[0])*RAD*A/Math.sqrt(q)*Math.cos(p),(point[1]-origin[1])*RAD*A*(1-E2)/q**1.5];
}
export function localBoundsToGeographic(bounds,origin){
  const unit=projectLocal([origin[0]+1,origin[1]+1],origin);
  return [origin[0]+bounds[0]/unit[0],origin[1]+bounds[1]/unit[1],origin[0]+bounds[2]/unit[0],origin[1]+bounds[3]/unit[1]];
}
export function tangentFrame([lon,lat,alt=0]){
  const l=lon*RAD,p=lat*RAD,sl=Math.sin(l),cl=Math.cos(l),sp=Math.sin(p),cp=Math.cos(p),n=A/Math.sqrt(1-E2*sp*sp);
  return [-sl,cl,0,0,-sp*cl,-sp*sl,cp,0,cp*cl,cp*sl,sp,0,(n+alt)*cp*cl,(n+alt)*cp*sl,(n*(1-E2)+alt)*sp,1];
}
export function stableHash(value){let h=2166136261;for(const char of value){h=Math.imul(h^char.charCodeAt(0),16777619);}return h>>>0;}
export function signedArea(ring){let a=0;for(let i=0;i<ring.length;i++){const p=ring[i],q=ring[(i+1)%ring.length];a+=p[0]*q[1]-q[0]*p[1];}return a/2;}
export function mesh(name,material,canonicalId=null){return {name,material,canonicalId,positions:[],normals:[],uvs:[],colors:[],indices:[]};}
export function triangle(out,points,uvs=[[0,0],[1,0],[1,1]],shade=1){
  const [a,b,c]=points,u=b.map((v,i)=>v-a[i]),v=c.map((n,i)=>n-a[i]);
  const n=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],length=Math.hypot(...n);
  if(length<1e-9)return;const index=out.positions.length/3;
  for(let i=0;i<3;i++){out.positions.push(...points[i]);out.normals.push(...n.map(x=>x/length));out.uvs.push(...uvs[i]);const s=Array.isArray(shade)?shade[i]:shade;out.colors.push(s,s,s);out.indices.push(index+i);}
}
export function quad(out,points,shade=1){triangle(out,[points[0],points[1],points[2]],[[0,0],[1,0],[1,1]],shade);triangle(out,[points[0],points[2],points[3]],[[0,0],[1,1],[0,1]],shade);}
/** Source-edge aligned box; a,b are east/north, offset is right-hand outward. */
export function edgeBox(out,a,b,y0,y1,depth,offset=0){
  const d=Math.hypot(b[0]-a[0],b[1]-a[1]);if(d<.02)return;const normal=[(b[1]-a[1])/d,-(b[0]-a[0])/d];
  const p=(q,y,k)=>[q[0]+normal[0]*k,y,-q[1]-normal[1]*k];
  const af=p(a,y0,offset+depth),bf=p(b,y0,offset+depth),at=p(a,y1,offset+depth),bt=p(b,y1,offset+depth),ab=p(a,y0,offset),bb=p(b,y0,offset),au=p(a,y1,offset),bu=p(b,y1,offset);
  quad(out,[af,bf,bt,at]);quad(out,[at,bt,bu,au]);quad(out,[ab,af,at,au],.84);quad(out,[bf,bb,bu,bt],.84);quad(out,[bb,ab,au,bu],.78);
}
