import { createBuilding, isVisible } from './building.js';
import { add, scale, subtract, normalize, cross, perspective, lookAt, clamp, radians, cameraBasis, orientationQuaternion, quaternionMultiply, quaternionInverse, quaternionSlerp, rotateVector, rayBox, dot } from './math.js';
import { DEFAULT_OPTICS, normalizeOptics, lensLayout, createLensRenderer } from './vr-optics.js';

const vertexSource = `
attribute vec3 aPosition; attribute vec3 aNormal;
uniform mat4 uProjection; uniform mat4 uView;
uniform vec3 uCenter; uniform vec3 uSize; uniform float uPointSize; uniform float uPointMax;
varying vec3 vNormal; varying vec3 vWorld; varying float vDepth;
void main(){
  vWorld = aPosition * uSize + uCenter; vNormal = aNormal;
  vec4 view = uView * vec4(vWorld,1.0); vDepth = -view.z;
  gl_Position = uProjection * view;
  gl_PointSize = clamp(uPointSize / max(0.3,-view.z),2.0,uPointMax);
}`;
// Particles in VR: half as many, half the size, at most 12 px across (30 px on a flat screen).
export const VR_PARTICLES = Object.freeze({ keep: 2, size: 0.5, maxPixels: 12 });
const fragmentSource = `
precision mediump float;
uniform vec3 uColor; uniform float uAlpha; uniform float uKind; uniform float uPoints;
varying vec3 vNormal; varying vec3 vWorld; varying float vDepth;
void main(){
  if(uPoints>0.5 && distance(gl_PointCoord,vec2(0.5))>0.5) discard;
  float light = 0.53 + 0.47 * max(0.0,dot(normalize(vNormal),normalize(vec3(0.5,1.0,0.7))));
  vec3 color = uColor * light;
  if(uKind>0.5 && uKind<1.5){
    float grain = sin(vWorld.x*35.0+sin(vWorld.z*3.0))*0.035;
    float joint = step(0.975,fract(vWorld.x*1.4));
    color *= 1.0 + grain - joint*0.15;
  }
  if(uKind>2.5) color=uColor;
  float fog = smoothstep(28.0,75.0,vDepth);
  gl_FragColor=vec4(mix(color,vec3(0.047,0.047,0.047),fog),uAlpha);
}`;

export function cubeVertices() {
  const faces = [
    [[1,0,0],[[1,-1,-1],[1,1,-1],[1,1,1],[1,-1,1]]],
    [[-1,0,0],[[-1,-1,1],[-1,1,1],[-1,1,-1],[-1,-1,-1]]],
    [[0,1,0],[[-1,1,-1],[-1,1,1],[1,1,1],[1,1,-1]]],
    [[0,-1,0],[[-1,-1,1],[-1,-1,-1],[1,-1,-1],[1,-1,1]]],
    [[0,0,1],[[1,-1,1],[1,1,1],[-1,1,1],[-1,-1,1]]],
    [[0,0,-1],[[-1,-1,-1],[-1,1,-1],[1,1,-1],[1,-1,-1]]]
  ];
  return new Float32Array(faces.flatMap(([normal,corners]) => [0,1,2,0,2,3].flatMap(i => [...corners[i].map(v=>v*.5),...normal])));
}

export function createViewer(canvas, { onMotion = () => {}, onError = () => {} } = {}) {
  const gl = canvas.getContext('webgl', {antialias:true,alpha:false,powerPreference:'high-performance'});
  if (!gl) throw new Error('3D graphics are unavailable. Enable hardware acceleration or try Chrome.');
  function shader(type, source) {
    const result=gl.createShader(type); gl.shaderSource(result,source); gl.compileShader(result);
    if (!gl.getShaderParameter(result,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(result));
    return result;
  }
  const program=gl.createProgram();
  gl.attachShader(program,shader(gl.VERTEX_SHADER,vertexSource));
  gl.attachShader(program,shader(gl.FRAGMENT_SHADER,fragmentSource));
  gl.bindAttribLocation(program,0,'aPosition');gl.bindAttribLocation(program,1,'aNormal');
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program,gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);
  const uniforms=Object.fromEntries(['Projection','View','Center','Size','Color','Alpha','Kind','Points','PointSize','PointMax'].map(name=>[name,gl.getUniformLocation(program,'u'+name)]));
  const position=gl.getAttribLocation(program,'aPosition'), normal=gl.getAttribLocation(program,'aNormal');
  function buffer(data, usage=gl.STATIC_DRAW) {
    const b=gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER,b); gl.bufferData(gl.ARRAY_BUFFER,data,usage); return b;
  }
  const cube=buffer(cubeVertices()), particles=buffer(new Float32Array(0),gl.DYNAMIC_DRAW);
  // A cloud model replaces the demo house while it is shown. Units are the mesh's fitted metres.
  let model=null,modelBuffer=null;
  const modelViewpoint=()=>[0,1.65,model.size[2]/2+4];
  // Hand-tracking selection: a reticle marks the view center; selectAtCenter() picks along that ray.
  let selected=null,reticle=false,reticlePinched=false;
  // Grab: a movable group follows the view (and the hand offset) while the pinch is held.
  let grab=null;
  // Simulation layers (from src/simulation via app.js): {thermal:{tiles}, heatloss:{recolor, streams}, airflow:{streams, tiles}}.
  let analysis=null;
  const onFloor=item=>!item.floor||state.floor==='all'||item.floor===Number(state.floor);
  const groupMembers=group=>building.boxes.filter(b=>b.group===group);
  const groupCenter=items=>{const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity];for(const b of items)for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],b.center[k]-b.size[k]/2);hi[k]=Math.max(hi[k],b.center[k]+b.size[k]/2);}return {center:lo.map((v,k)=>(v+hi[k])/2),half:hi.map((v,k)=>(v-lo[k])/2)};};
  function viewFrame(){const ray=centerRay();const b=state.vr?basis():(()=>{const f=ray.direction,r=normalize(cross(f,[0,1,0]));return {forward:f,right:r,up:cross(r,f)};})();return {origin:ray.origin,forward:b.forward,right:b.right,up:b.up};}
  const reticleBuffer=buffer(new Float32Array([0,0,0,0,1,0]));
  function bind(b) {
    gl.bindBuffer(gl.ARRAY_BUFFER,b);
    gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position,3,gl.FLOAT,false,24,0);
    gl.enableVertexAttribArray(normal); gl.vertexAttribPointer(normal,3,gl.FLOAT,false,24,12);
  }
  gl.enable(gl.DEPTH_TEST); gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
  gl.clearColor(.047,.047,.047,1);
  const building=createBuilding();
  const colorCache=new Map();
  const color = hex => {
    if (!colorCache.has(hex)) colorCache.set(hex,[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255));
    return colorCache.get(hex);
  };
  let state={view:'interior',floor:'all',layer:'architecture',vr:false};
  let orbit={yaw:.72,pitch:.48,distance:22,target:[0,2.1,0]};
  let yaw=0,pitch=0,vrPosition=[0,1.65,3.6],sensor=null,sensorTarget=null,sensorBase=null;
  let roomIndex=0,frameId=0,disposed=false,frames=0,motionActive=false,lastFrameTime=null;
  let optics={...DEFAULT_OPTICS},calibrating=false,lenses=null;
  const nativeMotion=Boolean(window.AeroformNative);
  const listeners=[];
  function listen(target,type,handler,options) { target.addEventListener(type,handler,options); listeners.push(()=>target.removeEventListener(type,handler,options)); }
  function clearSensor() { sensor=null;sensorTarget=null;sensorBase=null;motionActive=false; }
  function resetLook() {
    yaw=0;pitch=0;
    // Recenter against the latest reading and discard pending interpolation.
    sensor=sensorTarget;sensorBase=sensor?quaternionInverse(sensor):null;
  }
  // Tall (portrait phone) views start further back so the whole house fits the narrow width.
  const portraitFit=()=>{const aspect=(canvas.clientWidth||1)/Math.max(1,canvas.clientHeight||1);return aspect<1?Math.min(1.9,.85/aspect):1;};
  function resetOrbit() {
    if(model){orbit={yaw:.72,pitch:.42,distance:clamp(Math.max(...model.size)*2.4*portraitFit(),8,48),target:[0,model.size[1]/2,0]};return;}
    orbit={yaw:.72,pitch:state.view==='interior'?.48:.62,distance:clamp((state.view==='interior'?22:27)*portraitFit(),8,48),target:[0,state.floor==='2'?4.8:state.floor==='1'?1.3:2.1,0]};
  }
  function update(next,key) {
    const wasVR=state.vr; state={...next};
    if (key==='view'||key==='floor') resetOrbit();
    if (state.vr && !wasVR) { clearSensor();vrPosition=model?modelViewpoint():[0,state.floor==='2'?5.1:1.65,3.6]; roomIndex=0; resetLook(); }
    if (!state.vr && wasVR) {clearSensor();calibrating=false;}
  }
  const pointers=new Map(); let pinchDistance=null;
  listen(canvas,'pointerdown',e=>{ pointers.set(e.pointerId,[e.clientX,e.clientY]); canvas.setPointerCapture(e.pointerId); });
  listen(canvas,'pointermove',e=>{
    const last=pointers.get(e.pointerId); if(!last) return;
    pointers.set(e.pointerId,[e.clientX,e.clientY]);
    if(pointers.size===2 && !state.vr){
      const [a,b]=[...pointers.values()]; const distance=Math.hypot(a[0]-b[0],a[1]-b[1]);
      if(pinchDistance) orbit.distance=clamp(orbit.distance*pinchDistance/Math.max(1,distance),8,48);
      pinchDistance=distance; return;
    }
    const dx=e.clientX-last[0],dy=e.clientY-last[1];
    if(state.vr){ yaw-=dx*.004; pitch=clamp(pitch-dy*.004,-1.3,1.3); }
    else { orbit.yaw-=dx*.006; orbit.pitch=clamp(orbit.pitch+dy*.006,.12,1.35); }
  });
  for (const type of ['pointerup','pointercancel','lostpointercapture']) listen(canvas,type,e=>{pointers.delete(e.pointerId);pinchDistance=null;});
  listen(canvas,'wheel',e=>{e.preventDefault();if(!state.vr)orbit.distance=clamp(orbit.distance*Math.exp(e.deltaY*.001),8,48);},{passive:false});
  function acceptSensor(q) {
    if(!state.vr || !Array.isArray(q) || q.length!==4 || !q.every(Number.isFinite) || Math.hypot(...q)<1e-6)return;
    sensorTarget=normalize(q);
    if(!sensorBase){sensor=sensorTarget;sensorBase=quaternionInverse(sensor);}
    if(!motionActive){motionActive=true;onMotion('Head tracking active · drag to adjust');}
  }
  listen(window,'deviceorientation',e=>{
    if(nativeMotion || [e.alpha,e.beta,e.gamma].some(v=>v===null||!Number.isFinite(v)))return;
    acceptSensor(orientationQuaternion(e.alpha,e.beta,e.gamma,screen.orientation?.angle||0));
  });
  // Native and browser sensors use different reference frames. Never mix them.
  listen(window,'aeroform-orientation',e=>{if(nativeMotion)acceptSensor(e.detail);});
  listen(window,'orientationchange',clearSensor);
  function basis() {
    let b=cameraBasis(yaw,pitch);
    if(sensor&&sensorBase){
      const q=quaternionMultiply(sensorBase,sensor);
      b={forward:rotateVector(q,b.forward),right:rotateVector(q,b.right),up:rotateVector(q,b.up)};
    }
    return b;
  }
  function orbitEye() {
    const o=orbit;
    return add(o.target,[Math.sin(o.yaw)*Math.cos(o.pitch)*o.distance,Math.sin(o.pitch)*o.distance,Math.cos(o.yaw)*Math.cos(o.pitch)*o.distance]);
  }
  function centerRay() {
    if(state.vr)return {origin:[...vrPosition],direction:basis().forward};
    const eye=orbitEye();return {origin:eye,direction:normalize(subtract(orbit.target,eye))};
  }
  function drawReticle(eye,target) {
    if(!reticle)return;
    // In VR the mark sits 2.5 m ahead of the head, so both eyes converge on it at that depth.
    const point=state.vr?add(vrPosition,scale(normalize(subtract(target,eye)),2.5)):target;
    bind(reticleBuffer);gl.uniform3fv(uniforms.Center,point);gl.uniform3fv(uniforms.Size,[1,1,1]);
    gl.uniform3fv(uniforms.Color,reticlePinched?[1,1,1]:[.62,.85,1]);gl.uniform1f(uniforms.Kind,3);
    gl.uniform1f(uniforms.Points,1);gl.uniform1f(uniforms.PointSize,state.vr?30:200);gl.uniform1f(uniforms.Alpha,.95);
    gl.disable(gl.DEPTH_TEST);gl.drawArrays(gl.POINTS,0,1);gl.enable(gl.DEPTH_TEST);gl.uniform1f(uniforms.Points,0);
  }
  // Particle positions for this frame, written into particleData (6 floats each: position and an unused
  // normal, the cube layout) as batches of one colour, size and alpha. In VR the particles are close to your
  // eyes and fill the small per-eye view, so only one in VR_PARTICLES.keep is made, at VR_PARTICLES.size.
  let particleData=new Float32Array(6*4096),particleBuilt=-1,particleBatches=[];
  const particleSeeds=new WeakMap();
  // Fixed random numbers per particle, made once per stream or cluster (not every frame).
  const hash=(i,k)=>{const v=Math.sin((i+1)*k)*43758.5453;return v-Math.floor(v);};
  function seedsFor(item,count,make){let s=particleSeeds.get(item);if(!s||s.count!==count){s={count,values:make(count)};particleSeeds.set(item,s);}return s.values;}
  function buildParticles(layerViz,visible,time){
    let n=0;particleBatches=[];
    const thin=state.vr?VR_PARTICLES.keep:1,sizeScale=state.vr?VR_PARTICLES.size:1;
    const reserve=count=>{if((n+count)*6<=particleData.length)return;const next=new Float32Array(Math.max(particleData.length*2,(n+count+1024)*6));next.set(particleData.subarray(0,n*6));particleData=next;};
    const put=(x,y,z)=>{const o=n*6;particleData[o]=x;particleData[o+1]=y;particleData[o+2]=z;particleData[o+3]=0;particleData[o+4]=1;particleData[o+5]=0;n++;};
    const batch=(first,color,size,alpha)=>{if(n>first)particleBatches.push({first,count:n-first,color,size:size*sizeScale,alpha});};
    // Streams from the simulation: particles travel along each route with a fading three-step trail.
    for(const stream of layerViz?.streams??[]){
      if(!onFloor(stream))continue;
      const seeds=seedsFor(stream,stream.count,c=>Float32Array.from({length:c*3},(_,j)=>{const i=Math.floor(j/3),k=j%3;
        const v=k===0?Math.sin(i*12.9898)*43758.5453:k===1?Math.sin(i*78.233)*12345.6789:Math.sin(i*39.425)*24680.1357;return (v-Math.floor(v)-.5)*(k===1?.3:.35);}));
      const z=stream.size??1,{points,lengths,total}=stream;reserve(stream.count*3);
      for(const [k,size,alpha] of [[2,170,.25],[1,220,.5],[0,270,1]]){
        const first=n;
        for(let i=0;i<stream.count;i+=thin){
          let d=(i/stream.count*total+time*stream.speed-k*.22)%total;if(d<0)d+=total;
          let seg=1;while(seg<lengths.length-1&&lengths[seg]<d)seg++;
          const a=points[seg-1],b=points[seg],f=(d-lengths[seg-1])/(lengths[seg]-lengths[seg-1]||1);
          put(a[0]+(b[0]-a[0])*f+seeds[i*3],a[1]+(b[1]-a[1])*f+seeds[i*3+1],a[2]+(b[2]-a[2])*f+seeds[i*3+2]);
        }
        batch(first,stream.color,size*z,alpha);
      }
    }
    // Airflow without a simulation result: simple jets from the vents and AC units.
    if(state.layer==='airflow'&&!layerViz?.streams?.length){
      const first=n,sources=visible.filter(b=>b.type==='vent'||b.type==='ac');reserve(sources.length*90);
      for(const vent of sources)for(let i=0;i<90;i+=thin){
        const t=((i/90)+time*.15)%1,stream=(i%6)-2.5;
        put(vent.center[0]+stream*.12+Math.sin(t*3)*.25,vent.center[1]-.2-t*1.3,vent.center[2]+t*3);
      }
      batch(first,[.3,.95,.82],70,.8);
    }
    return n;
  }
  function drawEye(rect,eye,target,up,fov,time=0) {
    gl.useProgram(program);gl.enable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.depthMask(true);
    gl.viewport(...rect); gl.scissor(...rect);
    const projection=perspective(fov,rect[2]/rect[3]);
    // Parallel eye cameras: distant objects align at the physical lens centers.
    gl.uniformMatrix4fv(uniforms.Projection,false,projection);
    gl.uniformMatrix4fv(uniforms.View,false,lookAt(eye,target,up));
    gl.uniform1f(uniforms.Points,0);
    if(model){
      bind(modelBuffer);gl.uniform3fv(uniforms.Center,[0,0,0]);gl.uniform3fv(uniforms.Size,[1,1,1]);
      gl.uniform3fv(uniforms.Color,[.84,.9,.86]);gl.uniform1f(uniforms.Alpha,1);gl.uniform1f(uniforms.Kind,0);
      gl.drawArrays(gl.TRIANGLES,0,model.count);drawReticle(eye,target);return;
    }
    bind(cube);
    const visible=building.boxes.filter(b=>isVisible(b,state));
    const transparent=visible.filter(b=>b.transparent).sort((a,b)=>Math.hypot(...subtract(b.center,eye))-Math.hypot(...subtract(a.center,eye)));
    function drawBox(b) {
      gl.uniform3fv(uniforms.Center,b.center);gl.uniform3fv(uniforms.Size,b.size);
      const picked=b===selected||(grab&&b.group===grab.group);
      const heat=state.layer==='heatloss'?analysis?.heatloss?.recolor?.[b.id]:null;
      // Airflow layer: the building is dimmed so the air streams stand out.
      const dim=state.layer==='airflow'&&analysis?.airflow?.dim?analysis.airflow.dim:1;
      gl.uniform3fv(uniforms.Color,picked?[.62,.85,1]:heat??(dim<1?color(b.color).map(v=>v*dim):color(b.color)));gl.uniform1f(uniforms.Alpha,b.transparent?(picked?.6:heat?.55:.28):1);
      gl.uniform1f(uniforms.Kind,heat?0:b.color==='#95704e'?1:0);
      gl.drawArrays(gl.TRIANGLES,0,36);
    }
    gl.depthMask(true);visible.filter(b=>!b.transparent).forEach(drawBox);
    gl.depthMask(false);transparent.forEach(drawBox);gl.depthMask(true);
    const layerViz=analysis?.[state.layer];
    if(layerViz?.tiles?.length){
      gl.depthMask(false);
      for(const tile of layerViz.tiles){
        if(!onFloor(tile))continue;
        gl.uniform3fv(uniforms.Center,tile.center);gl.uniform3fv(uniforms.Size,tile.size);gl.uniform3fv(uniforms.Color,tile.color);
        gl.uniform1f(uniforms.Alpha,tile.alpha??.55);gl.uniform1f(uniforms.Kind,3);gl.drawArrays(gl.TRIANGLES,0,36);
      }
      gl.depthMask(true);
    }
    // Particles: air streams (Airflow) and heat through the windows and door (Heat loss). Worked out once per
    // displayed frame (both VR eyes share them) into one reused buffer.
    if(state.layer==='airflow'||layerViz?.streams?.length) {
      if(particleBuilt!==frames){
        particleBuilt=frames;const count=buildParticles(layerViz,visible,time);
        gl.bindBuffer(gl.ARRAY_BUFFER,particles);gl.bufferData(gl.ARRAY_BUFFER,particleData.subarray(0,count*6),gl.DYNAMIC_DRAW);
      }
      gl.uniform3fv(uniforms.Center,[0,0,0]);gl.uniform3fv(uniforms.Size,[1,1,1]);
      gl.uniform1f(uniforms.Kind,3);gl.uniform1f(uniforms.Points,1);gl.depthMask(false);
      gl.uniform1f(uniforms.PointMax,state.vr?VR_PARTICLES.maxPixels:30);
      bind(particles);
      for(const b of particleBatches){
        gl.uniform3fv(uniforms.Color,b.color);gl.uniform1f(uniforms.PointSize,b.size);gl.uniform1f(uniforms.Alpha,b.alpha);gl.drawArrays(gl.POINTS,b.first,b.count);
      }
      gl.depthMask(true);gl.uniform1f(uniforms.Points,0);
    }
    drawReticle(eye,target);
  }
  function render(time=0) {
    if(disposed)return;
    const elapsed=lastFrameTime===null?0:Math.max(0,time-lastFrameTime);lastFrameTime=time;
    // Filter once per displayed frame so both eyes share one pose. A 20 ms time
    // constant damps small sensor noise without a long camera catch-up animation.
    if(state.vr&&sensor&&sensorTarget)sensor=quaternionSlerp(sensor,sensorTarget,1-Math.exp(-elapsed/20));
    const dpr=Math.min(window.devicePixelRatio||1,state.vr?1.5:1.7);
    const width=Math.max(2,Math.round(canvas.clientWidth*dpr)),height=Math.max(1,Math.round(canvas.clientHeight*dpr));
    if(canvas.width!==width||canvas.height!==height){canvas.width=width;canvas.height=height;}
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.depthMask(true);gl.disable(gl.SCISSOR_TEST);gl.viewport(0,0,width,height);
    gl.clearColor(...(state.vr?[0,0,0,1]:[.047,.047,.047,1]));gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.SCISSOR_TEST);
    if(state.vr) {
      try{
        lenses??=createLensRenderer(gl);
        const layout=lensLayout(width,height,optics),b=basis();
        for(const {rect,offset} of layout.eyes){
          const eye=add(vrPosition,scale(b.right,offset)),source=lenses.begin(layout.diameter);
          drawEye(source,eye,add(eye,b.forward),b.up,radians(optics.fov),time*.001);
          lenses.present(rect,optics,calibrating);
        }
      }catch(error){onError(error.message);return;}
    } else {
      drawEye([0,0,width,height],orbitEye(),orbit.target,[0,1,0],radians(48),time*.001);
    }
    gl.disable(gl.SCISSOR_TEST);frames++;frameId=requestAnimationFrame(render);
  }
  listen(canvas,'webglcontextlost',e=>{e.preventDefault();cancelAnimationFrame(frameId);onError('Graphics paused. Reload the viewer to restore the scene.');});
  render();
  return {
    update, recenter:resetLook, reset:resetOrbit,
    setOptics(value){optics=normalizeOptics(value);},
    setCalibration(value){calibrating=state.vr&&Boolean(value);},
    setModel(mesh) {
      if(modelBuffer){gl.deleteBuffer(modelBuffer);modelBuffer=null;}
      selected=null;
      model=mesh?{count:mesh.vertices.length/6,size:[...mesh.size],name:mesh.name||'Model'}:null;
      if(mesh)modelBuffer=buffer(mesh.vertices);
      resetOrbit();
      if(state.vr){vrPosition=model?modelViewpoint():[0,state.floor==='2'?5.1:1.65,3.6];roomIndex=0;resetLook();}
    },
    setReticle(enabled,pinched=false){reticle=Boolean(enabled);reticlePinched=Boolean(pinched);},
    // Picks the nearest visible part along the view-center ray and highlights it. Returns null on a miss.
    selectAtCenter() {
      const {origin,direction}=centerRay();
      if(model){
        const distance=rayBox(origin,direction,[0,model.size[1]/2,0],model.size);
        return distance===null?null:{name:model.name,type:'model',floor:null,distance};
      }
      let best=null,bestDistance=Infinity;
      for(const b of building.boxes){
        if(!isVisible(b,state))continue;
        const distance=rayBox(origin,direction,b.center,b.size);
        if(distance!==null&&distance<bestDistance){best=b;bestDistance=distance;}
      }
      selected=best;
      return best?{name:best.name,type:best.type??null,floor:best.floor,distance:bestDistance}:null;
    },
    clearSelection(){selected=null;},
    // Walk: move the VR viewpoint along the level (horizontal) part of where you look.
    moveForward(metres) {
      if(!state.vr||!Number.isFinite(metres)||metres===0)return [...vrPosition];
      const f=basis().forward,flat=Math.hypot(f[0],f[2]);
      if(flat<1e-3)return [...vrPosition];
      vrPosition=[vrPosition[0]+f[0]/flat*metres,vrPosition[1],vrPosition[2]+f[2]/flat*metres];
      return [...vrPosition];
    },
    // Pinch on a movable item starts a grab; returns null when the center ray hits nothing movable.
    beginGrab() {
      if(model)return null;
      const hit=this.selectAtCenter();
      if(!hit||!selected?.movable||!selected.group)return null;
      const items=groupMembers(selected.group),frame=viewFrame(),{center}=groupCenter(items);
      const rel=subtract(center,frame.origin);
      grab={group:selected.group,name:selected.name,items,starts:items.map(b=>[...b.center]),start:center,
        local:[dot(rel,frame.right),dot(rel,frame.up),dot(rel,frame.forward)],distance:Math.max(.5,dot(rel,frame.forward))};
      return {name:grab.name,group:grab.group,distance:grab.distance};
    },
    // offset: {right, up, forward} metres from the hand (see locomotion.grabOffset). The item keeps its
    // place relative to your view, so turning your head carries it too. It never goes below the floor.
    updateGrab(offset={}) {
      if(!grab)return null;
      const frame=viewFrame(),l=grab.local;
      const forward=Math.min(25,Math.max(.4,l[2]+(offset.forward||0)));
      let target=add(frame.origin,add(add(scale(frame.right,l[0]+(offset.right||0)),scale(frame.up,l[1]+(offset.up||0))),scale(frame.forward,forward)));
      const {half}=groupCenter(grab.items),floorY=(grab.items[0].floor===2?3.45:0)+half[1];
      target=[target[0],Math.max(floorY,target[1]),target[2]];
      const delta=subtract(target,grab.start);
      grab.items.forEach((b,i)=>{b.center=add(grab.starts[i],delta);});
      return {name:grab.name,group:grab.group,position:target};
    },
    endGrab() {
      if(!grab)return null;
      const done={name:grab.name,group:grab.group,offset:subtract(grab.items[0].center,grab.items[0].home)};
      grab=null;return done;
    },
    get grabbing(){return grab?{name:grab.name,group:grab.group}:null;},
    // Saved moves: {group: [dx, dy, dz]} from each item's designed position.
    applyMoves(moves={}) {
      for(const b of building.boxes){
        const d=b.group&&Array.isArray(moves[b.group])&&moves[b.group].length===3&&moves[b.group].every(Number.isFinite)?moves[b.group]:[0,0,0];
        b.center=add(b.home,d);
      }
    },
    // Place the VR viewpoint and face a point (used for going outside / back inside).
    // VR: move to the same spot one floor up (+1) or down (-1). Returns the new floor, or null at the top/bottom.
    changeFloor(delta) {
      if(!state.vr||model)return null;
      const level=vrPosition[1]>3?2:1,next=level+Math.sign(delta);
      if(next<1||next>2)return null;
      vrPosition=[vrPosition[0],1.65+(next-1)*3.45,vrPosition[2]];
      return next;
    },
    goTo(position,target) {
      if(!state.vr||!Array.isArray(position))return;
      vrPosition=[...position];resetLook();
      if(Array.isArray(target)){const d=normalize(subtract(target,position));yaw=Math.atan2(d[0],-d[2]);pitch=clamp(Math.asin(clamp(d[1],-1,1)),-1.3,1.3);}
    },
    setAnalysis(value){analysis=value||null;},
    movableGroups:()=>[...new Set(building.boxes.filter(b=>b.movable).map(b=>b.group))],
    nextRoom() {
      if(model){vrPosition=modelViewpoint();resetLook();return model.name;}
      roomIndex=(roomIndex+1)%4;
      const base=state.floor==='2'?3.45:0;
      const rooms=[[0,1.65,3.6],[-3.8,1.65,-.8],[4.8,1.65,-2.2],[0,5.1,3.6]];
      vrPosition=[...rooms[roomIndex]];
      if(roomIndex<3)vrPosition[1]+=base;
      if(roomIndex===3&&state.floor==='1') {roomIndex=0;vrPosition=[...rooms[0]];}
      resetLook();return ['Hall','Living room','Bedroom','Upper hall'][roomIndex];
    },
    inspect:()=>({frames,state:{...state},orbit:{...orbit},vrPosition:[...vrPosition],motionActive,optics:{...optics},calibrating,reticle,grabbing:grab?grab.group:null,selected:selected?selected.name:null,model:model?{name:model.name,triangles:model.count/3,size:[...model.size]}:null,visibleObjects:building.boxes.filter(b=>isVisible(b,state)).length}),
    dispose(){disposed=true;cancelAnimationFrame(frameId);listeners.forEach(fn=>fn());lenses?.dispose();gl.deleteBuffer(cube);if(modelBuffer)gl.deleteBuffer(modelBuffer);gl.deleteBuffer(reticleBuffer);gl.deleteBuffer(particles);gl.deleteProgram(program);}
  };
}
