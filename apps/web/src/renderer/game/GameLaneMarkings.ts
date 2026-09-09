type Point=readonly[number,number];
export interface GameMarkingSegment{key:string;a:Point;b:Point;width:number;lanes:number;eligible:boolean;level:number;clips?:readonly(readonly Point[])[]}
export const GAME_LANE_MARKING_STYLE=Object.freeze({width:.14,dash:3,gap:6,edgeMargin:.3,endMargin:3,junctionMargin:3,maxCandidates:32768,indexEntries:150000});
interface Options{center:Point;phaseOrigin:Point;maxMarks:number;isPointClear:(x:number,z:number,radius:number)=>boolean;spend:(n?:number)=>void}
const cross=(a:Point,b:Point)=>a[0]*b[1]-a[1]*b[0];
const sub=(a:Point,b:Point):Point=>[a[0]-b[0],a[1]-b[1]];
const add=(a:Point,b:Point,t:number):Point=>[a[0]+b[0]*t,a[1]+b[1]*t];
const box=(s:GameMarkingSegment)=>[Math.min(s.a[0],s.b[0]),Math.min(s.a[1],s.b[1]),Math.max(s.a[0],s.b[0]),Math.max(s.a[1],s.b[1])] as const;
/** Decorative paint only. Source lane/route positions, identities and movement stay untouched. */
export function prepareGameLaneMarkings(input:readonly GameMarkingSegment[],options:Options){
  const style=GAME_LANE_MARKING_STYLE,segments=[...new Map(input.map(s=>[s.key,s])).values()];
  const markings:{points:Point[];sourceKey:string;offset:number;clips?:readonly(readonly Point[])[]}[]=[],diagnostics={skippedJunctionMarks:0,skippedClearanceMarks:0,truncated:false};
  const buckets=new Map<string,GameMarkingSegment[]>(),large:GameMarkingSegment[]=[];let entries=0,candidates=0;
  for(const segment of segments){const [x0,z0,x1,z1]=box(segment).map(v=>Math.floor(v/64));
    if((x1!-x0!+1)*(z1!-z0!+1)>256){large.push(segment);continue}
    for(let z=z0!;z<=z1!;z++)for(let x=x0!;x<=x1!;x++){
      if(++entries>style.indexEntries)throw Error('Lane marking spatial index budget exceeded');const key=`${x}:${z}`,bucket=buckets.get(key)??[];bucket.push(segment);buckets.set(key,bucket);
    }
  }
  const eligible=segments.filter(s=>s.eligible&&s.width>=4.4&&s.lanes>=2&&s.lanes<=8&&(s.width-.6)/s.lanes>=2.1)
    .sort((a,b)=>Math.hypot((a.a[0]+a.b[0])/2-options.center[0],(a.a[1]+a.b[1])/2-options.center[1])
      -Math.hypot((b.a[0]+b.b[0])/2-options.center[0],(b.a[1]+b.b[1])/2-options.center[1])||a.key.localeCompare(b.key));
  for(const segment of eligible){const direction=sub(segment.b,segment.a),length=Math.hypot(...direction);if(length<16)continue;
    const unit:Point=[direction[0]/length,direction[1]/length],normal:Point=[-unit[1],unit[0]],nearby=new Set(large),extent=box(segment),margin=segment.width/2+20;
    for(let z=Math.floor((extent[1]-margin)/64);z<=Math.floor((extent[3]+margin)/64);z++)for(let x=Math.floor((extent[0]-margin)/64);x<=Math.floor((extent[2]+margin)/64);x++){
      options.spend();for(const other of buckets.get(`${x}:${z}`)??[])nearby.add(other);
    }
    const excluded:[number,number][]=[];
    for(const other of nearby){if(other===segment||other.level!==segment.level)continue;options.spend();
      const delta=sub(other.b,other.a),otherLength=Math.hypot(...delta);if(otherLength<.05)continue;
      if(Math.abs((direction[0]*delta[0]+direction[1]*delta[1])/(length*otherLength))>.966)continue;
      const determinant=cross(direction,delta);if(Math.abs(determinant)<1e-8)continue;
      const difference=sub(other.a,segment.a),t=cross(difference,delta)/determinant,u=cross(difference,direction)/determinant;
      if(t<-.01||t>1.01||u<-.01||u>1.01)continue;
      const radius=Math.max(segment.width,other.width)/2+style.junctionMargin,at=Math.max(0,Math.min(1,t))*length;
      excluded.push([at-radius,at+radius]);
    }
    const period=style.dash+style.gap,start=(segment.a[0]+options.phaseOrigin[0])*unit[0]+(segment.a[1]+options.phaseOrigin[1])*unit[1];
    const first=Math.ceil((start+style.endMargin)/period),last=Math.floor((start+length-style.endMargin-style.dash)/period);
    for(let lane=1;lane<segment.lanes;lane++){
      const offset=(lane-segment.lanes/2)*(segment.width-2*style.edgeMargin)/segment.lanes;
      for(let index=first;index<=last;index++){
        options.spend();if(++candidates>style.maxCandidates||markings.length>=options.maxMarks){diagnostics.truncated=true;return{markings,diagnostics}}
        const lo=index*period-start,hi=lo+style.dash;options.spend(excluded.length);if(excluded.some(([a,b])=>hi>a&&lo<b)){diagnostics.skippedJunctionMarks++;continue}
        const center=add(add(segment.a,unit,(lo+hi)/2),normal,offset),radius=Math.hypot(style.dash/2,style.width/2);
        if(!options.isPointClear(center[0],center[1],radius)){diagnostics.skippedClearanceMarks++;continue}
        const a=add(add(segment.a,unit,lo),normal,offset),b=add(add(segment.a,unit,hi),normal,offset);
        markings.push({sourceKey:segment.key,offset,clips:segment.clips,points:[add(a,normal,-style.width/2),add(b,normal,-style.width/2),add(b,normal,style.width/2),add(a,normal,style.width/2)]});
      }
    }
  }
  return{markings,diagnostics};
}
