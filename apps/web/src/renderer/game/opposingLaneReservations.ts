type Point=readonly[number,number];
export interface OpposingLanePath {readonly key:string;readonly points:readonly Point[]}
interface Actor {readonly id:string;readonly pathKey:string;readonly distance:number;readonly desired:number;readonly entered:boolean;readonly fresh:boolean}
interface Cap {distance:number;visible:boolean}
interface Segment {pathKey:string;start:number;t0:number;lo:number;hi:number;direction:1|-1}
interface Approach {pathKey:string;entry:number;exit:number;direction:1|-1}
interface Section {approaches:Approach[];exclusive?:boolean}
const MARGIN=5,EPS=1e-5;
export const OPPOSING_LANE_LIMITS=Object.freeze({paths:2048,segments:8192,pairChecks:250000,mergeChecks:250000,contacts:8192,sections:512,approaches:65536});

/** Direction reservations on an existing undisplaced display centreline.
 * This creates no lane, reroute, junction or surveyed grade assertion. */
export class OpposingLaneReservations {
  private sections:Section[]=[];
  private eligible=new Set<string>();
  diagnostics={paths:0,segments:0,pairChecks:0,mergeChecks:0,contacts:0,sections:0,approaches:0,exclusiveSections:0,overflow:0};
  clear(){this.sections=[];this.eligible.clear();this.diagnostics={paths:0,segments:0,pairChecks:0,mergeChecks:0,contacts:0,sections:0,approaches:0,exclusiveSections:0,overflow:0};}
  sync(paths:readonly OpposingLanePath[]):void{
    this.clear();const d=this.diagnostics,lines=new Map<string,Segment[]>();
    const fail=()=>{d.overflow++;this.sections=[];};
    if(paths.length>8192||paths.some(path=>!path.key||path.key.length>500000||path.points.length<2||path.points.length>8192))throw Error('Invalid opposing source inventory');
    // Eligibility is complete even if a later bounded build fails: no remaining
    // source path silently escapes the conservative overflow hold.
    this.eligible=new Set(paths.map(path=>path.key));
    d.paths=paths.length;
    if(paths.length>OPPOSING_LANE_LIMITS.paths){fail();return;}
    for(const path of paths){
      let start=0;
      for(let i=1;i<path.points.length;i++){
        if(++d.segments>OPPOSING_LANE_LIMITS.segments){fail();return;}
        const a=path.points[i-1]!,b=path.points[i]!,length=Math.hypot(b[0]-a[0],b[1]-a[1]);
        if(!Number.isFinite(length)||length<EPS)throw Error('Invalid opposing source segment');
        let dx=(b[0]-a[0])/length,dz=(b[1]-a[1])/length;const direction=dx<0||Math.abs(dx)<1e-8&&dz<0?-1:1;
        dx*=direction;dz*=direction;
        const key=`${Math.round(Math.atan2(dz,dx)*1e8)}:${Math.round((-a[0]*dz+a[1]*dx)*100000)}`;
        const t0=a[0]*dx+a[1]*dz,t1=t0+direction*length;
        const segment:Segment={pathKey:path.key,start,t0,lo:Math.min(t0,t1),hi:Math.max(t0,t1),direction};
        const list=lines.get(key)??[];list.push(segment);lines.set(key,list);start+=length;
      }
    }
    for(const segments of lines.values()){
      if(!segments.some(s=>s.direction===1)||!segments.some(s=>s.direction===-1))continue;
      segments.sort((a,b)=>a.lo-b.lo||a.hi-b.hi||a.pathKey.localeCompare(b.pathKey));
      const overlaps:{lo:number;hi:number;refs:Set<Segment>}[]=[];
      for(let i=0;i<segments.length;i++)for(let j=i+1;j<segments.length;j++){
        const a=segments[i]!,b=segments[j]!;if(b.lo>=a.hi-EPS)break;
        if(++d.pairChecks>OPPOSING_LANE_LIMITS.pairChecks){fail();return;}
        if(a.direction===b.direction)continue;
        if(++d.contacts>OPPOSING_LANE_LIMITS.contacts){fail();return;}
        overlaps.push({lo:Math.max(a.lo,b.lo),hi:Math.min(a.hi,b.hi),refs:new Set([a,b])});
      }
      overlaps.sort((a,b)=>a.lo-b.lo||a.hi-b.hi);
      const merged:typeof overlaps=[];
      for(const overlap of overlaps){const last=merged.at(-1);
        if(last&&overlap.lo<=last.hi+EPS){last.hi=Math.max(last.hi,overlap.hi);for(const ref of overlap.refs)last.refs.add(ref);}
        else merged.push(overlap);
      }
      for(const interval of merged){
        if(this.sections.length>=OPPOSING_LANE_LIMITS.sections){fail();return;}
        const byPath=new Map<string,Approach>();
        for(const ref of interval.refs){
          const lo=Math.max(interval.lo,ref.lo),hi=Math.min(interval.hi,ref.hi);
          const a=ref.start+(lo-ref.t0)*ref.direction,b=ref.start+(hi-ref.t0)*ref.direction;
          const entry=Math.min(a,b)-MARGIN,exit=Math.max(a,b)+MARGIN,key=`${ref.pathKey}:${ref.direction}`,old=byPath.get(key);
          if(old){old.entry=Math.min(old.entry,entry);old.exit=Math.max(old.exit,exit);}
          else byPath.set(key,{pathKey:ref.pathKey,direction:ref.direction,entry,exit});
        }
        d.approaches+=byPath.size;
        if(d.approaches>OPPOSING_LANE_LIMITS.approaches){fail();return;}
        this.sections.push({approaches:[...byPath.values()]});
      }
    }
    // A bend must drain as one corridor: separate line reservations can give
    // consecutive occupied intervals to opposite cars and deadlock. Link only
    // overlapping arclength intervals on the SAME authored path. The direction
    // basis of each line is arbitrary, so carry parity through these links.
    const parent=this.sections.map((_,i)=>i),parity=this.sections.map(()=>1),exclusive=this.sections.map(()=>false);
    const find=(index:number):{root:number;sign:number}=>{
      let root=index,sign=1;while(parent[root]!==root){sign*=parity[root]!;root=parent[root]!;}
      return {root,sign};
    };
    const refsByPath=new Map<string,{section:number;approach:Approach}[]>();
    this.sections.forEach((section,index)=>{for(const approach of section.approaches){
      const refs=refsByPath.get(approach.pathKey)??[];refs.push({section:index,approach});refsByPath.set(approach.pathKey,refs);
    }});
    for(const refs of refsByPath.values()){
      refs.sort((a,b)=>a.approach.entry-b.approach.entry||a.section-b.section);
      for(let i=0;i<refs.length;i++)for(let j=i+1;j<refs.length;j++){
        const a=refs[i]!,b=refs[j]!;if(b.approach.entry>a.approach.exit+EPS)break;
        if(++d.mergeChecks>OPPOSING_LANE_LIMITS.mergeChecks){fail();return;}
        const left=find(a.section),right=find(b.section);
        const relation=a.approach.direction*b.approach.direction*left.sign*right.sign;
        if(left.root===right.root){
          // A self-reversing authored path can have contradictory orientation.
          // Preserve incumbent drain, but admit only one actor at a time there.
          if(relation!==1)exclusive[left.root]=true;
        }else{
          const low=Math.min(left.root,right.root),high=Math.max(left.root,right.root);
          parent[high]=low;parity[high]=relation;exclusive[low]=exclusive[left.root]!||exclusive[right.root]!;
        }
      }
    }
    const components=new Map<number,Section>(),componentRefs=new Map<number,Map<string,Approach>>();
    this.sections.forEach((section,index)=>{
      const {root,sign}=find(index),component=components.get(root)??{approaches:[],exclusive:exclusive[root]};
      const refs=componentRefs.get(root)??new Map<string,Approach>();
      for(const approach of section.approaches){
        const direction=approach.direction*sign as 1|-1,key=`${approach.pathKey}:${direction}`;
        const old=refs.get(key);
        if(old){old.entry=Math.min(old.entry,approach.entry);old.exit=Math.max(old.exit,approach.exit);}
        else{const ref={...approach,direction};refs.set(key,ref);component.approaches.push(ref);}
      }
      components.set(root,component);componentRefs.set(root,refs);
    });
    this.sections=[...components.values()];d.sections=this.sections.length;
    d.approaches=this.sections.reduce((sum,section)=>sum+section.approaches.length,0);
    d.exclusiveSections=this.sections.filter(section=>section.exclusive).length;
  }
  constrain(actors:readonly Actor[]):Map<string,Cap>{
    const result=new Map(actors.map(actor=>[actor.id,{distance:actor.desired,visible:actor.entered}]));
    if(this.diagnostics.overflow){
      for(const actor of actors)if(this.eligible.has(actor.pathKey))result.set(actor.id,{distance:actor.distance,visible:actor.entered&&!actor.fresh});
      return result;
    }
    const byPath=new Map<string,Actor[]>();
    for(const actor of actors){const list=byPath.get(actor.pathKey)??[];list.push(actor);byPath.set(actor.pathKey,list);}
    for(const section of this.sections){
      const visitors=section.approaches.flatMap(approach=>(byPath.get(approach.pathKey)??[]).map(actor=>({actor,approach})));
      const occupied=visitors.filter(({actor,approach})=>actor.entered&&!actor.fresh&&actor.distance>approach.entry+EPS&&actor.distance<approach.exit-EPS);
      const reservations=[...occupied];
      visitors.sort((a,b)=>Number(a.actor.fresh)-Number(b.actor.fresh)
        ||(b.actor.distance-b.approach.entry)-(a.actor.distance-a.approach.entry)||a.actor.id.localeCompare(b.actor.id));
      for(const visitor of visitors){const {actor,approach}=visitor,cap=result.get(actor.id)!;
        if(!actor.entered||actor.distance>=approach.exit-EPS||cap.distance<=approach.entry+EPS&&actor.distance<approach.entry-EPS)continue;
        if(occupied.some(item=>item.actor.id===actor.id))continue;
        if(reservations.every(item=>item.actor.id===actor.id||!section.exclusive&&item.approach.direction===approach.direction))reservations.push(visitor);
        else{
          cap.distance=Math.min(cap.distance,actor.fresh?Math.max(0,approach.entry):Math.max(actor.distance,approach.entry));
          if(actor.fresh&&approach.entry<0)cap.visible=false;
        }
      }
    }
    return result;
  }
}
