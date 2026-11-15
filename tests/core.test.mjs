import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBuilding, isVisible } from '../src/building.js';
import { createViewerState, validateDesign, MAX_UPLOAD_BYTES, eyeLayout } from '../src/viewer-state.js';
import { cameraBasis, rayBox, normalize, dot, perspective, lookAt, orientationQuaternion, quaternionInverse, quaternionMultiply, rotateVector } from '../src/math.js';
import { createViewer, cubeVertices } from '../src/viewer.js';
import { DEFAULT_OPTICS, SCREEN_WIDTH_MM, SCREEN_HEIGHT_MM, lensLayout, lensSample, normalizeOptics, calculateAutomaticFit, normalizeLensFit } from '../src/vr-optics.js';
import { createServer } from '../scripts/server.mjs';
import { parseModel, parseStl, parseObj, buildMesh, canRender, MODEL_FIT_METRES } from '../src/mesh.js';
import { createCloud, storageName, displayName } from '../src/cloud.js';
import { SUPABASE_URL, CLOUD_BUCKET } from '../src/cloud-config.js';
import { pinchRatio, createPinchDetector, createHandTracker } from '../src/hand-tracking.js';
import { createAppHarness } from './dom-harness.mjs';
const near=(a,b,epsilon=1e-6)=>assert.ok(Math.abs(a-b)<epsilon,`${a} differs from ${b}`);
const building=createBuilding();

test('demo has two floors, valid dimensions, openings, furniture, HVAC, and honest provenance',()=>{
  assert.equal(building.units,'m');assert.equal(building.source.interpretedByAI,false);
  assert.deepEqual([...new Set(building.rooms.map(r=>r.level))],[1,2]);
  assert.ok(building.boxes.length>100);
  for(const item of building.boxes){assert.equal(item.center.length,3);assert.ok(item.center.every(Number.isFinite));assert.ok(item.size.every(v=>v>0));assert.match(item.color,/^#[a-f0-9]{6}$/i);}
  for(const level of [1,2])for(const type of ['vent','ac'])assert.ok(building.boxes.some(b=>b.floor===level&&b.type===type));
  assert.ok(building.boxes.some(b=>b.name==='door'));
});
test('floor selection filters geometry and roof consistently across every view',()=>{
  for(const view of ['interior','exterior'])for(const floor of ['all','1','2'])for(const vr of [false,true]){
    const visible=building.boxes.filter(b=>isVisible(b,{view,floor,vr}));
    assert.ok(visible.length>10);
    if(floor!=='all')assert.ok(visible.every(b=>!b.floor||b.floor===Number(floor)));
    assert.equal(visible.some(b=>b.roof),view==='exterior'&&floor==='all'&&!vr);
    if(view==='interior'&&!vr)assert.ok(visible.every(b=>!b.cutaway));
  }
});
test('state changes publish snapshots and reject unsupported layers and values',()=>{
  const changes=[];const state=createViewerState((s,key)=>changes.push([s,key]));
  for(const [key,value] of [['floor','2'],['view','exterior'],['layer','airflow'],['layer','thermal'],['vr',true],['vr',false]])state.set(key,value);
  assert.equal(changes.length,6);assert.equal(state.get().floor,'2');
  const copy=state.get();copy.floor='1';assert.equal(state.get().floor,'2');
  assert.throws(()=>state.set('layer','energy'));assert.throws(()=>state.set('layer','cfd'));assert.throws(()=>state.set('floor','3'));assert.throws(()=>state.set('vr','true'));
});
test('file selection accepts any file type and rejects missing, oversized, and empty files',()=>{
  assert.equal(MAX_UPLOAD_BYTES,50*1024*1024);
  for(const name of ['plan.PDF','house.png','model.ifc','scene.GLB','part.STL','a.obj','notes.txt','noextension'])assert.equal(validateDesign({name,size:1024}).name,name);
  for(const file of [null,{name:'x.pdf',size:0},{name:'x.stl',size:MAX_UPLOAD_BYTES+1}])assert.ok(validateDesign(file).error);
  const maliciousName='<img src=x onerror=alert(1)>.png';assert.equal(validateDesign({name:maliciousName,size:2}).name,maliciousName);
});
test('stereo viewports cover even, odd, portrait, landscape and zero-sized layouts',()=>{
  for(const [w,h] of [[1920,1080],[915,412],[412,915],[1,1],[0,0]]){
    const result=eyeLayout(w,h);assert.equal(result.left[2]+result.right[2],result.width);assert.equal(result.right[0],result.left[2]);assert.equal(result.stereoAspect,.5);assert.ok(Number.isFinite(result.aspect));
  }
});
test('perspective matrix preserves aspect and maps near/far to clip planes',()=>{
  const p=perspective(Math.PI/2,2,.1,100);near(p[0],.5);near(p[5],1);
  const zclip=z=>(p[10]*z+p[14])/(-z);near(zclip(-.1),-1);near(zclip(-100),1);
});
test('lookAt positions camera at origin and preserves a right-handed orthonormal basis',()=>{
  const m=lookAt([0,0,5],[0,0,0]);near(m[0],1);near(m[5],1);near(m[10],1);near(m[14],-5);
  for(const yaw of [-3,0,1,2])for(const pitch of [-1,0,1]){
    const b=cameraBasis(yaw,pitch);near(dot(b.forward,b.right),0);near(dot(b.forward,b.up),0);near(Math.hypot(...b.right),1);near(Math.hypot(...b.up),1);
  }
});
test('orientation quaternions remain normalized in portrait and both landscape orientations',()=>{
  for(const angle of [0,90,180,270])for(const alpha of [0,45,180,359]){
    const q=orientationQuaternion(alpha,90,20,angle);near(Math.hypot(...q),1);
    const identity=quaternionMultiply(quaternionInverse(q),q);identity.forEach((v,i)=>near(v,i===3?1:0));
    const v=rotateVector(q,[0,0,-1]);near(Math.hypot(...v),1);
  }
});
test('cube triangles match face normals and produce 36 vertices',()=>{
  const v=cubeVertices();assert.equal(v.length,36*6);
  for(let i=0;i<v.length;i+=6){assert.ok([v[i],v[i+1],v[i+2]].every(x=>Math.abs(x)===.5));near(Math.hypot(v[i+3],v[i+4],v[i+5]),1);}
});

// A recording WebGL adapter checks render/control integration, not GPU shader compilation.
function rendererHarness({native=false,framebufferComplete=true}={}) {
  const calls=[];const gl=new Proxy({COMPILE_STATUS:1,LINK_STATUS:2,TRIANGLES:3,POINTS:4},{get(target,key){
    if(key in target)return target[key];
    if(key==='getShaderParameter'||key==='getProgramParameter')return()=>true;
    if(key==='checkFramebufferStatus')return()=>framebufferComplete?1:0;
    if(key.startsWith('create'))return()=>({});
    if(key==='getUniformLocation')return(_,name)=>name;
    if(key==='getAttribLocation')return(_,name)=>name==='aNormal'?1:0;
    if(/^[A-Z_0-9]+$/.test(key))return 1;
    return(...args)=>calls.push([key,...args]);
  }});
  const canvas=new EventTarget();Object.assign(canvas,{clientWidth:915,clientHeight:412,width:0,height:0,getContext:()=>gl,setPointerCapture:()=>{}});
  const win=new EventTarget();win.devicePixelRatio=1;let frame,time=0;
  if(native)win.AeroformNative={setVrMode:()=>{}};
  globalThis.window=win;globalThis.screen={orientation:{angle:90}};
  globalThis.requestAnimationFrame=fn=>{frame=fn;return 1;};globalThis.cancelAnimationFrame=()=>{};
  const motion=[];const errors=[];
  const viewer=createViewer(canvas,{onMotion:x=>motion.push(x),onError:x=>errors.push(x)});
  const step=(elapsed=1000/60)=>{calls.length=0;time+=elapsed;frame(time);};
  const dispatch=(target,type,props={})=>{const e=new Event(type);Object.assign(e,props);target.dispatchEvent(e);};
  return {viewer,canvas,win,calls,motion,errors,step,dispatch};
}
test('VR renders square eye textures and circular lens regions, then restores the mono viewport',()=>{
  const h=rendererHarness(),state={view:'interior',floor:'all',layer:'architecture',vr:true};
  h.viewer.update(state,'vr');h.step();
  const layout=lensLayout(915,412);
  const viewports=h.calls.filter(c=>c[0]==='viewport').map(c=>c.slice(1));
  for(const eye of layout.eyes)assert.ok(viewports.some(v=>JSON.stringify(v)===JSON.stringify(eye.rect)));
  const views=h.calls.filter(c=>c[0]==='uniformMatrix4fv'&&c[1]==='uView');assert.equal(views.length,2);assert.notEqual(views[0][3][12],views[1][3][12]);
  const projections=h.calls.filter(c=>c[0]==='uniformMatrix4fv'&&c[1]==='uProjection');
  for(const [, , ,p] of projections){near(p[0],p[5]);near(p[8],0);}
  h.viewer.update({...state,vr:false},'vr');h.step();assert.deepEqual(h.calls.filter(c=>c[0]==='viewport').at(-1).slice(1),[0,0,915,412]);h.viewer.dispose();
});
test('S24+ lens centers have adjustable physical spacing with equal heights and no eye overlap',()=>{
  const w=3120,h=1440;
  for(const spacing of [55,62,72])for(const height of [-6,0,6]){
    const layout=lensLayout(w,h,{...DEFAULT_OPTICS,spacing,height}),[left,right]=layout.eyes;
    near((right.center[0]-left.center[0])*SCREEN_WIDTH_MM/w,spacing);
    near(left.center[1],right.center[1]);near(left.center[0]+right.center[0],w);
    assert.ok(left.rect[0]+left.rect[2]<=w/2);assert.ok(right.rect[0]>=w/2);
    for(const {rect:[x,y,d]} of layout.eyes){assert.ok(x>=0&&y>=0&&x+d<=w&&y+d<=h);}
  }
  for(const [width,height] of [[915,412],[412,915],[1,1],[0,0]]){
    const layout=lensLayout(width,height);assert.ok(layout.diameter>0);
    assert.ok(layout.eyes.flatMap(e=>e.rect).every(Number.isFinite));
  }
});
test('automatic fit derives S24+ screen geometry and preserves 62 mm spacing at different resolutions',()=>{
  const fit=calculateAutomaticFit();
  near(Math.hypot(...fit.screenMm),169.1);near(SCREEN_WIDTH_MM/SCREEN_HEIGHT_MM,3120/1440);
  near(fit.centerMm[1]-fit.centerMm[0],62);near(fit.centerMm[0]+fit.centerMm[1],SCREEN_WIDTH_MM);
  near(fit.centerPercent[0],29.81,.01);near(fit.centerPercent[1],70.19,.01);near(fit.diameterMm,60);
  assert.ok(fit.diameterMm<62);assert.ok(fit.diameterMm<SCREEN_HEIGHT_MM-5.9);
  for(const [width,height] of [[3120,1440],[2340,1080],[1560,720],[1040,480]]){
    const layout=lensLayout(width,height,fit.optics);
    near(layout.separation/width*SCREEN_WIDTH_MM,62);
    assert.ok(Math.abs(layout.diameter/width*SCREEN_WIDTH_MM-60)<SCREEN_WIDTH_MM/width);
    layout.eyes.forEach((eye,i)=>near(eye.center[0]/width*100,fit.centerPercent[i]));
  }
  assert.equal(normalizeLensFit({mode:'unknown',manual:{spacing:999}}).mode,'auto');
  assert.equal(normalizeLensFit({mode:'manual',manual:{spacing:999}}).manual.spacing,72);
});
test('lens mapping keeps centers aligned, corners black, and both eyes isolated at every correction strength',()=>{
  for(const correction of [0,22,50]){
    assert.deepEqual(lensSample(0,0,correction),[.5,.5]);assert.equal(lensSample(1,1,correction),null);
    near(lensSample(1,0,correction)[0],1);
    for(let x=0;x<=1;x+=.05){
      const right=lensSample(x,0,correction),left=lensSample(-x,0,correction);
      near(left[0]+right[0],1);near(left[1],right[1]);
      assert.ok(right.every(v=>v>=0&&v<=1));
    }
  }
  assert.ok(lensSample(.5,0,50)[0]<lensSample(.5,0,0)[0]);
  assert.deepEqual(normalizeOptics(null),DEFAULT_OPTICS);
  const bounded=normalizeOptics({spacing:999,size:-3,depth:NaN,distortion:Infinity,height:999});
  assert.equal(bounded.spacing,72);assert.equal(bounded.size,75);assert.equal(bounded.depth,100);assert.equal(bounded.height,6);
});
test('parallel stereo has crossed near disparity, aligned far directions and a zero-depth option',()=>{
  const h=rendererHarness();h.viewer.update({view:'interior',floor:'all',layer:'architecture',vr:true},'vr');h.step();
  const views=h.calls.filter(c=>c[0]==='uniformMatrix4fv'&&c[1]==='uView').map(c=>c[3]);
  const projection=h.calls.find(c=>c[0]==='uniformMatrix4fv'&&c[1]==='uProjection')[3];
  const xAt=(m,distance)=>projection[0]*m[12]/distance-projection[8];
  assert.ok(xAt(views[0],2)>xAt(views[1],2),'near objects must have crossed stereo disparity');
  near(xAt(views[0],1e9),xAt(views[1],1e9));
  h.viewer.setOptics({...DEFAULT_OPTICS,depth:0});h.step();
  const mono=h.calls.filter(c=>c[0]==='uniformMatrix4fv'&&c[1]==='uView');assert.deepEqual(mono[0][3],mono[1][3]);
  h.viewer.setCalibration(true);h.step();assert.equal(h.viewer.inspect().calibrating,true);
  assert.equal(h.calls.filter(c=>c[0]==='uniform1f'&&c[1]==='uCalibration'&&c[2]===1).length,2);
  h.viewer.update({view:'interior',floor:'all',layer:'architecture',vr:false},'vr');assert.equal(h.viewer.inspect().calibrating,false);h.viewer.dispose();
});
test('lens framebuffer failures show an error instead of silently rendering a broken VR view',()=>{
  const h=rendererHarness({framebufferComplete:false});h.viewer.update({view:'interior',floor:'all',layer:'architecture',vr:true},'vr');h.step();
  assert.match(h.errors[0],/Lens rendering is unavailable/);h.viewer.dispose();
});
test('drag rotates overview, touch zoom stays bounded, and reset restores camera',()=>{
  const h=rendererHarness();const initial=h.viewer.inspect().orbit.yaw;
  h.dispatch(h.canvas,'pointerdown',{pointerId:1,clientX:100,clientY:100});h.dispatch(h.canvas,'pointermove',{pointerId:1,clientX:200,clientY:120});
  assert.notEqual(h.viewer.inspect().orbit.yaw,initial);
  h.dispatch(h.canvas,'wheel',{deltaY:-100000});assert.equal(h.viewer.inspect().orbit.distance,8);
  h.viewer.reset();assert.equal(h.viewer.inspect().orbit.yaw,initial);h.viewer.dispose();
});
test('VR drag changes the view without motion permission; sensors and recenter also respond',()=>{
  const h=rendererHarness();h.viewer.update({view:'interior',floor:'all',layer:'architecture',vr:true},'vr');h.step();
  const first=h.calls.find(c=>c[0]==='uniformMatrix4fv'&&c[1]==='uView')[3];
  h.dispatch(h.canvas,'pointerdown',{pointerId:1,clientX:100,clientY:100});h.dispatch(h.canvas,'pointermove',{pointerId:1,clientX:160,clientY:110});h.step();
  const second=h.calls.find(c=>c[0]==='uniformMatrix4fv'&&c[1]==='uView')[3];assert.notDeepEqual(first,second);
  h.viewer.recenter();h.step();assert.deepEqual(first,h.calls.find(c=>c[0]==='uniformMatrix4fv'&&c[1]==='uView')[3]);
  h.dispatch(h.win,'deviceorientation',{alpha:0,beta:90,gamma:0});assert.equal(h.motion.length,1);assert.equal(h.viewer.inspect().motionActive,true);
  h.dispatch(h.win,'deviceorientation',{alpha:null,beta:null,gamma:null});assert.equal(h.motion.length,1);h.viewer.dispose();
});
const vrState={view:'interior',floor:'all',layer:'architecture',vr:true};
const viewMatrix=h=>h.calls.find(c=>c[0]==='uniformMatrix4fv'&&c[1]==='uView')[3];
const yawQuaternion=degrees=>[0,Math.sin(degrees*Math.PI/360),0,Math.cos(degrees*Math.PI/360)];
const nativePose=(h,q)=>h.dispatch(h.win,'aeroform-orientation',{detail:q});
const viewYaw=h=>Math.atan2(viewMatrix(h)[2],viewMatrix(h)[0])*180/Math.PI;

test('APK head tracking never alternates between native and browser coordinate frames',()=>{
  const h=rendererHarness({native:true});h.viewer.update(vrState,'vr');
  h.dispatch(h.win,'deviceorientation',{alpha:35,beta:65,gamma:15});
  assert.equal(h.viewer.inspect().motionActive,false);
  nativePose(h,yawQuaternion(0));h.step();const initial=viewMatrix(h);
  for(let i=0;i<12;i++){
    h.dispatch(h.win,'deviceorientation',{alpha:80+i,beta:65,gamma:15});h.step();
    assert.deepEqual(viewMatrix(h),initial,'browser readings must not move the native camera');
    nativePose(h,yawQuaternion(0));h.step();assert.deepEqual(viewMatrix(h),initial);
  }
  nativePose(h,yawQuaternion(30));h.step(100);assert.ok(Math.abs(viewYaw(h))>28);
  h.viewer.dispose();
});
test('browser VR ignores native bridge events and still follows browser motion',()=>{
  const h=rendererHarness();h.viewer.update(vrState,'vr');
  nativePose(h,yawQuaternion(30));assert.equal(h.viewer.inspect().motionActive,false);
  h.dispatch(h.win,'deviceorientation',{alpha:0,beta:90,gamma:0});h.step();const initial=viewMatrix(h);
  nativePose(h,yawQuaternion(90));h.step();assert.deepEqual(viewMatrix(h),initial);
  h.dispatch(h.win,'deviceorientation',{alpha:30,beta:90,gamma:0});h.step(100);assert.notDeepEqual(viewMatrix(h),initial);
  h.viewer.dispose();
});
test('head tracking attenuates small alternating noise while following deliberate turns promptly',()=>{
  const h=rendererHarness({native:true});h.viewer.update(vrState,'vr');nativePose(h,yawQuaternion(0));h.step();
  let peak=0;
  for(let i=0;i<120;i++){
    nativePose(h,yawQuaternion(i%2?.2:-.2));h.step();
    if(i>10)peak=Math.max(peak,Math.abs(viewYaw(h)));
  }
  assert.ok(peak<.1,`stationary noise should be filtered; peak was ${peak} degrees`);
  nativePose(h,yawQuaternion(45));h.step();
  assert.ok(Math.abs(viewYaw(h))>10&&Math.abs(viewYaw(h))<40,'turn must start promptly without an immediate jump');
  for(let i=0;i<5;i++)h.step();
  assert.ok(Math.abs(Math.abs(viewYaw(h))-45)<1,'camera must settle within 100 ms');h.viewer.dispose();
});
test('recenter clears pending smoothing and invalid/sign-flipped readings never shake the view',()=>{
  const h=rendererHarness({native:true});h.viewer.update(vrState,'vr');nativePose(h,yawQuaternion(0));h.step();const initial=viewMatrix(h);
  nativePose(h,yawQuaternion(60));h.step();h.viewer.recenter();
  for(const q of [yawQuaternion(60),yawQuaternion(60).map(v=>-v),[0,0,0,0],[NaN,0,0,1],[0,0,0],[Infinity,0,0,1]]){
    nativePose(h,q);h.step();viewMatrix(h).forEach((v,i)=>near(v,initial[i]));
  }
  h.viewer.update({...vrState,vr:false},'vr');nativePose(h,yawQuaternion(120));
  h.viewer.update(vrState,'vr');nativePose(h,yawQuaternion(-30));h.step();
  viewMatrix(h).forEach((v,i)=>near(v,initial[i]));
  h.dispatch(h.win,'orientationchange');nativePose(h,yawQuaternion(90));h.step();
  viewMatrix(h).forEach((v,i)=>near(v,initial[i]));h.viewer.dispose();
});
test('head tracking smoothing uses elapsed time consistently at 30, 60 and 120 fps',()=>{
  const angles=[];
  for(const fps of [30,60,120]){
    const h=rendererHarness({native:true});h.viewer.update(vrState,'vr');nativePose(h,yawQuaternion(0));h.step();
    nativePose(h,yawQuaternion(90));
    for(let i=0;i<fps/10;i++)h.step(1000/fps);
    angles.push(viewYaw(h));h.viewer.dispose();
  }
  for(const angle of angles)near(angle,angles[0],.01);
});
test('preview particles follow floor filtering; simulated thermal tiles follow the floor too',()=>{
  const h=rendererHarness();const state={view:'interior',floor:'all',layer:'airflow',vr:false};h.viewer.update(state,'layer');h.step();
  const all=h.calls.filter(c=>c[0]==='drawArrays'&&c[1]===4).at(-1)[3];
  h.viewer.update({...state,floor:'1'},'floor');h.step();const one=h.calls.filter(c=>c[0]==='drawArrays'&&c[1]===4).at(-1)[3];assert.equal(all,one*2);
  // Thermal tiles come only from a simulation result; none are drawn before one exists.
  h.viewer.update({...state,floor:'all',layer:'thermal'},'layer');h.step();const before=h.calls.filter(c=>c[0]==='uniform3fv'&&c[1]==='uColor'&&c[2][0]===.9).length;
  h.viewer.setAnalysis({thermal:{tiles:[{center:[0,.03,0],size:[1,.04,1],color:[.9,.2,.1],floor:1},{center:[0,3.48,0],size:[1,.04,1],color:[.9,.2,.1],floor:2}]}});
  h.step();assert.equal(h.calls.filter(c=>c[0]==='uniform3fv'&&c[1]==='uColor'&&c[2][0]===.9).length-before,2);
  h.viewer.update({...state,floor:'2',layer:'thermal'},'floor');h.step();assert.equal(h.calls.filter(c=>c[0]==='uniform3fv'&&c[1]==='uColor'&&c[2][0]===.9).length,1);h.viewer.dispose();
});
test('room navigation stays on isolated floors and reports graphics loss',()=>{
  const h=rendererHarness();h.viewer.update({view:'interior',floor:'1',layer:'architecture',vr:true},'vr');
  for(let i=0;i<9;i++){assert.ok(h.viewer.nextRoom());near(h.viewer.inspect().vrPosition[1],1.65);}
  h.dispatch(h.canvas,'webglcontextlost');assert.equal(h.errors.length,1);h.viewer.dispose();
});
test('WebGL absence fails with an actionable error',()=>assert.throws(()=>createViewer({getContext:()=>null}),/3D graphics are unavailable/));

test('UI style: square corners, neutral dark greys with the lime accent, no status dots, corner brackets or all-caps labels',async()=>{
  const root=new URL('../',import.meta.url),css=await readFile(new URL('styles.css',root),'utf8'),html=await readFile(new URL('index.html',root),'utf8');
  assert.deepEqual([...css.matchAll(/radius:([^;}]+)/g)].map(m=>m[1]).filter(v=>v.trim()!=='0'),[],'no rounded corners');
  // Custom scroll bars: square, themed, and not disabled in Chrome by a standard scrollbar-width/color outside @supports.
  assert.match(css,/::-webkit-scrollbar-thumb\{[^}]*border-radius:0/);assert.match(css,/::-webkit-scrollbar-thumb:hover\{background:var\(--accent\)/);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g,'').replace(/@supports not selector\(::-webkit-scrollbar\)\{[^}]*\}\}/,''),/scrollbar-(width|color)/);
  assert.match(css,/--deep:#0c0c0c/);assert.match(css,/--panel:#151515/);assert.match(css,/--accent:#9fd8ff/);assert.doesNotMatch(css,/--lime|#b7f36d/,'no green accent left');
  // No green-tinted greys left (green only as the lime accent).
  const tinted=[...css.matchAll(/#([0-9a-f]{6})/gi)].map(m=>m[1]).filter(h=>{const [r,g,b]=[0,2,4].map(i=>parseInt(h.slice(i,i+2),16));return g>r+6&&g>b+6&&g<200;});
  assert.deepEqual(tinted,[],'no green-tinted greys');
  for(const gone of ['project-label','live-dot','layer-dot','status-ring','frame-corner','class="eyebrow"','view-mode-label','Atrium House / Prototype'])assert.ok(!html.includes(gone),gone);
  assert.deepEqual([...html.matchAll(/>([A-Z][A-Z0-9 ·&;+-]{3,})</g)].map(m=>m[1]),['AEROWAY'],'no all-caps labels except the name');
  // Name: AEROWAY in the accent blue, with no placeholder logo square.
  assert.ok(html.includes('<title>AEROWAY')&&!html.includes('brand-orb')&&!/>AEROFORM</.test(html));assert.match(css,/\.brand\{color:var\(--accent\)/);
  assert.ok(!/PROTOTYPE|AEROFORM LAB/.test(html),'no capitalised footer');
  // Help texts describe the current VR controls, not the removed swipes and waves.
  assert.ok(!/swipe|wave up|point goes/i.test(html),'no outdated control descriptions');
  for(const f of ['src/viewer.js','src/vr-optics.js'])assert.doesNotMatch(await readFile(new URL(f,root),'utf8'),/\.085,\.065|0\.085,0\.065/,f+' background is neutral');
});
test('actual application starts, enables scene buttons, changes layers/views/floors and opens help',async()=>{
  const h=await createAppHarness();assert.equal(h.doc.body.dataset.viewer,'ready');assert.equal(h.find('#vr-btn').disabled,false);
  h.click('#help-btn');assert.equal(h.find('#help-modal').open,true);h.click('#close-help');assert.equal(h.find('#help-modal').open,false);
  // Desktop top bar: Analysis opens the analysis panel.
  h.click('#analysis-top-btn');assert.equal(h.find('#analysis-modal').open,true);h.dispatch(h.win,'keydown',{key:'Escape'});assert.equal(h.find('#analysis-modal').open,false);
  for(const view of ['exterior','interior']){h.click(`[data-view="${view}"]`);assert.equal(h.win.aeroform.inspect().state.view,view);}
  for(const layer of ['thermal','airflow','architecture']){h.click(`[data-layer="${layer}"]`);assert.equal(h.win.aeroform.inspect().state.layer,layer);assert.equal(h.find('#simulation-note').hidden,layer==='architecture');}
  for(const floor of ['2','1','all']){h.click(`[data-floor="${floor}"]`);assert.equal(h.win.aeroform.inspect().state.floor,floor);}
  h.click('#panel-btn');assert.equal(h.find('#sidebar').classList.contains('open'),true);h.click('#close-panel');assert.equal(h.find('#sidebar').classList.contains('open'),false);
  assert.equal(h.find('[data-layer="energy"]'),null,'no EnergyPlus layer button');
  h.click('#reset-btn');
});
test('VR has no buttons; entering starts hand tracking and clap listening, leaving (Escape) stops them; repeated entry works',async()=>{
  const h=await createAppHarness({storage:new Map([['aeroform-vr-guide','0']])}); // guide: see its own test
  // The only button in the VR overlay is the lens-alignment one, and it is hidden unless the target is showing.
  assert.deepEqual(h.find('#stereo-hud').querySelectorAll('button').map(b=>b.attributes.id),['alignment-btn']);assert.equal(h.find('#alignment-btn').hidden,true);
  for(let i=0;i<3;i++){
    h.click('#vr-btn');await h.settle();assert.equal(h.win.aeroform.inspect().state.vr,true);assert.equal(h.find('#stereo-hud').hidden,false);
    assert.equal(h.doc.body.classList.contains('stereo-mode'),true);
    // No camera or microphone here: both were tried and report why they are off, without leaving VR.
    assert.match(h.find('#hands-status').textContent,/camera/i);assert.equal(h.win.aeroform.inspect().clap,'error');
    h.dispatch(h.win,'keydown',{key:'Escape'});
    assert.equal(h.win.aeroform.inspect().state.vr,false);assert.equal(h.find('#stereo-hud').hidden,true);assert.equal(h.win.aeroform.inspect().clap,'off');
  }
  assert.equal(h.motionRequests(),3);
});
test('native VR bridge receives enter/exit; Android back exits stereo mode',async()=>{
  const h=await createAppHarness({native:true});h.click('#vr-btn');assert.deepEqual(h.nativeCalls,[true]);assert.equal(h.motionRequests(),0);
  // The first Back closes the controls guide; the next leaves VR.
  assert.equal(h.find('#vr-guide').open,true);h.dispatch(h.win,'aeroform-back');assert.equal(h.find('#vr-guide').open,false);assert.deepEqual(h.nativeCalls,[true]);
  h.dispatch(h.win,'aeroform-back');assert.deepEqual(h.nativeCalls,[true,false]);assert.equal(h.win.aeroform.inspect().state.vr,false);
});
test('VR controls guide: shown on entering VR, closed by Start, Escape or a clap; “Don’t show again” is remembered; not shown for Lens fit',async()=>{
  const storage=new Map();const h=await createAppHarness({storage});
  h.click('#vr-btn');assert.equal(h.find('#vr-guide').open,true);
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');const guide=html.slice(html.indexOf('<dialog id="vr-guide"'),html.indexOf('</dialog>',html.indexOf('<dialog id="vr-guide"')));
  for(const [sign,does] of [['Thumbs up','Up a floor'],['Thumbs down','Down a floor'],['1 finger','Thermal'],['2 fingers','Airflow'],['3 fingers','Heat loss'],['4 fingers','Architecture'],['Open hand','Walk forward'],['Pinch','Grab or select'],['Clap','Recenter'],['Headset Back','Leave VR']])
    assert.match(guide,new RegExp('<b>'+sign+'[^<]*</b><small>'+does),sign);
  h.click('#vr-guide-ok');assert.equal(h.find('#vr-guide').open,false);assert.equal(h.win.aeroform.inspect().state.vr,true);
  assert.match(h.find('#motion-status').textContent,/1–4 fingers: layer/);
  h.dispatch(h.win,'keydown',{key:'Escape'});assert.equal(h.win.aeroform.inspect().state.vr,false);
  // Leaving VR closes it too; ticking "Don't show again" before Start keeps it closed next time.
  h.click('#vr-btn');assert.equal(h.find('#vr-guide').open,true);h.dispatch(h.win,'keydown',{key:'Escape'});assert.equal(h.find('#vr-guide').open,false);assert.equal(h.win.aeroform.inspect().state.vr,true);
  h.dispatch(h.win,'keydown',{key:'Escape'});
  h.click('#vr-btn');h.find('#vr-guide-skip').checked=true;h.click('#vr-guide-ok');assert.equal(storage.get('aeroform-vr-guide'),'0');
  h.dispatch(h.win,'keydown',{key:'Escape'});h.click('#vr-btn');assert.equal(h.find('#vr-guide').open,false);h.dispatch(h.win,'keydown',{key:'Escape'});
  const fresh=await createAppHarness();fresh.click('#lens-fit-btn');assert.equal(fresh.find('#lens-modal').open,true);assert.equal(fresh.find('#vr-guide').open,false);
});
test('hand signs: thumbs up / down change floor, one to four fingers pick the layer, in VR and in the normal view',async()=>{
  const h=await createAppHarness({storage:new Map([['aeroform-vr-guide','0']])});const sign=l=>h.win.aeroform.runSign(l),get=()=>h.win.aeroform.inspect().state;
  for(const [label,layer] of [['point','thermal'],['two_fingers','airflow'],['three_fingers','heatloss'],['four_fingers','architecture']]){sign(label);assert.equal(get().layer,layer,label);}
  sign('point');assert.match(h.find('#scene-status').textContent,/1 finger · Thermal/);sign('point');assert.match(h.find('#scene-status').textContent,/already showing Thermal/);
  sign('thumbs_up');assert.equal(get().floor,'2');sign('thumbs_up');assert.match(h.find('#scene-status').textContent,/top floor/);sign('thumbs_down');assert.equal(get().floor,'1');
  h.click('#vr-btn');assert.equal(get().vr,true);const y=h.win.aeroform.inspect().vrPosition[1];
  sign('thumbs_up');assert.ok(h.win.aeroform.inspect().vrPosition[1]>y+3,'up a floor in VR');assert.match(h.find('#motion-status').textContent,/Thumbs up · floor 2/);
  sign('thumbs_down');assert.ok(Math.abs(h.win.aeroform.inspect().vrPosition[1]-y)<1e-6);
  sign('two_fingers');assert.equal(get().layer,'airflow');assert.match(h.find('#motion-status').textContent,/2 fingers · Airflow/);
});
test('lens fit controls update rendering, persist settings, show alignment and close correctly on Android Back',async()=>{
  const storage=new Map(),h=await createAppHarness({native:true,storage});
  h.click('#vr-btn');h.click('#lens-fit-btn');assert.equal(h.find('#lens-modal').open,true);
  assert.equal(h.win.aeroform.inspect().lensMode,'auto');
  assert.equal(h.find('#lens-manual-controls').hidden,true);assert.equal(h.find('#lens-spacing').disabled,true);
  assert.deepEqual(h.win.aeroform.inspect().optics,calculateAutomaticFit().optics);
  assert.equal(h.find('#lens-auto-centers').textContent,'29.8% / 70.2%');
  h.click('#lens-mode-manual');assert.equal(h.find('#lens-spacing').disabled,false);
  h.find('#lens-spacing').value='65';h.dispatch(h.find('#lens-spacing'),'input');
  assert.equal(h.win.aeroform.inspect().optics.spacing,65);assert.equal(h.find('#lens-spacing-value').textContent,'65 mm');
  assert.equal(JSON.parse(storage.get('aeroform-lens-fit-v2')).manual.spacing,65);
  h.click('#lens-target');assert.equal(h.find('#lens-modal').open,false);assert.equal(h.win.aeroform.inspect().calibrating,true);
  assert.equal(h.find('#alignment-btn').hidden,false);
  h.click('#alignment-btn');assert.equal(h.win.aeroform.inspect().calibrating,false);assert.equal(h.find('#lens-modal').open,true);assert.equal(h.find('#alignment-btn').hidden,true);
  h.dispatch(h.win,'aeroform-back');
  h.click('#lens-fit-btn');h.dispatch(h.win,'aeroform-back');assert.equal(h.find('#lens-modal').open,false);assert.equal(h.win.aeroform.inspect().state.vr,true);
  h.dispatch(h.win,'aeroform-back');
  const next=await createAppHarness({native:true,storage});assert.equal(next.win.aeroform.inspect().optics.spacing,65);assert.equal(next.win.aeroform.inspect().lensMode,'manual');
  // Lens fit is in the menu: outside VR it opens VR with the lens settings on top.
  next.click('#lens-fit-btn');assert.equal(next.win.aeroform.inspect().state.vr,true);assert.equal(next.find('#lens-modal').open,true);next.click('#lens-reset');assert.deepEqual(next.win.aeroform.inspect().optics,calculateAutomaticFit().optics);
  next.dispatch(next.win,'aeroform-back');assert.equal(next.find('#lens-modal').open,false);
});
test('switching Auto and Manual preserves separate settings, including after restarting in Auto',async()=>{
  const storage=new Map(),h=await createAppHarness({native:true,storage});
  h.click('#vr-btn');h.click('#lens-fit-btn');h.click('#lens-mode-manual');
  for(const [key,value] of [['spacing',67],['height',2],['depth',40]]){h.find('#lens-'+key).value=String(value);h.dispatch(h.find('#lens-'+key),'input');}
  const manual=h.win.aeroform.inspect().optics;
  h.click('#lens-mode-auto');assert.deepEqual(h.win.aeroform.inspect().optics,calculateAutomaticFit().optics);
  h.find('#lens-spacing').value='70';h.dispatch(h.find('#lens-spacing'),'input');assert.equal(h.win.aeroform.inspect().optics.spacing,62);
  h.dispatch(h.win,'aeroform-back');
  const next=await createAppHarness({native:true,storage});assert.equal(next.win.aeroform.inspect().lensMode,'auto');
  next.click('#vr-btn');next.click('#lens-fit-btn');next.click('#lens-mode-manual');
  assert.deepEqual(next.win.aeroform.inspect().optics,manual);assert.equal(next.find('#lens-auto-details').hidden,true);
  next.click('#lens-mode-auto');assert.equal(next.find('#lens-auto-details').hidden,false);next.dispatch(next.win,'aeroform-back');
});
test('older manual fits migrate without overriding Auto; malformed or unavailable storage remains usable',async()=>{
  const legacy={...DEFAULT_OPTICS,spacing:66,height:-1,distortion:35};
  const storage=new Map([['aeroform-lens-fit-v1',JSON.stringify(legacy)]]);
  const h=await createAppHarness({native:true,storage});assert.equal(h.win.aeroform.inspect().lensMode,'auto');assert.equal(h.win.aeroform.inspect().optics.spacing,62);
  h.click('#vr-btn');h.click('#lens-fit-btn');h.click('#lens-mode-manual');assert.deepEqual(h.win.aeroform.inspect().optics,legacy);h.dispatch(h.win,'aeroform-back');
  for(const store of [new Map([['aeroform-lens-fit-v2','{broken']]),{get(){throw new Error('Storage denied');},set(){throw new Error('Storage denied');}}]){
    const next=await createAppHarness({native:true,storage:store});assert.equal(next.doc.body.dataset.viewer,'ready');assert.equal(next.win.aeroform.inspect().lensMode,'auto');
    next.click('#vr-btn');next.click('#lens-fit-btn');next.click('#lens-mode-manual');next.find('#lens-spacing').value='64';next.dispatch(next.find('#lens-spacing'),'input');
    assert.equal(next.win.aeroform.inspect().optics.spacing,64);next.dispatch(next.win,'aeroform-back');
  }
});
test('actual upload handler uses textContent, uploads any file, and keeps the demo for non-3D files',async()=>{
  const calls=[];const fetch=async(url,options={})=>{calls.push({url,options});return new Response(JSON.stringify(url.includes('/list/')?[]:{Key:'x'}),{status:200});};
  const h=await createAppHarness({fetch});await h.settle();
  h.find('#design-upload').files=[{name:'<script>alert(1)</script>.pdf',size:100,type:'application/pdf'}];
  h.dispatch(h.find('#design-upload'),'change');await h.settle();
  assert.equal(h.find('#upload-title').textContent,'<script>alert(1)</script>.pdf');assert.match(h.find('#upload-description').textContent,/Uploaded.*stored only/);
  const upload=calls.find(c=>c.options.method==='POST'&&!c.url.includes('/list/'));
  assert.match(upload.url,/\/storage\/v1\/object\/aeroform-models\/\d+-script-alert-1-script-\.pdf$/);
  assert.equal(upload.options.headers['Content-Type'],'application/pdf');assert.equal(h.win.aeroform.inspect().cloudModel,null);
  h.find('#design-upload').files=[{name:'empty.stl',size:0}];h.dispatch(h.find('#design-upload'),'change');await h.settle();
  assert.equal(h.find('#upload-error').hidden,false);assert.equal(h.doc.body.dataset.viewer,'ready');
});
const asciiStl='solid cube\n'+[[0,0,0, 10,0,0, 0,20,0],[0,0,0, 0,20,0, 0,0,40]].map(t=>'facet normal 0 0 0\nouter loop\n'+[0,3,6].map(i=>`vertex ${t[i]} ${t[i+1]} ${t[i+2]}`).join('\n')+'\nendloop\nendfacet').join('\n')+'\nendsolid cube\n';
function binaryStl(triangles,header='solid but actually binary'){
  const bytes=new Uint8Array(84+triangles.length*50),view=new DataView(bytes.buffer);
  new TextEncoder().encodeInto(header,bytes);view.setUint32(80,triangles.length,true);
  triangles.forEach((t,i)=>t.forEach((v,j)=>view.setFloat32(84+i*50+12+j*4,v,true)));
  return bytes.buffer;
}
test('STL and OBJ parsing: binary, ASCII, quads, negative indices; Z-up conversion and 8 m fit',()=>{
  const binary=parseStl(binaryStl([[0,0,0, 10,0,0, 0,20,0]]));assert.deepEqual([...binary],[0,0,0,10,0,0,0,20,0]);
  assert.equal(parseStl(new TextEncoder().encode(asciiStl)).length,18);
  const mesh=parseModel('Part.STL',new TextEncoder().encode(asciiStl));
  assert.equal(mesh.triangles,2);assert.equal(mesh.vertices.length,2*3*6);
  // STL Z-up: the 40-unit Z extent becomes the height (Y) and is fitted to 8 m.
  near(mesh.size[1],MODEL_FIT_METRES);near(mesh.size[0],2);near(mesh.size[2],4);
  let minY=Infinity;for(let i=1;i<mesh.vertices.length;i+=6)minY=Math.min(minY,mesh.vertices[i]);near(minY,0);
  for(let i=0;i<mesh.vertices.length;i+=6)near(Math.hypot(mesh.vertices[i+3],mesh.vertices[i+4],mesh.vertices[i+5]),1);
  const obj=parseObj(new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 1 1 0\nv 0 1 0\nf 1/1/1 2/2/2 3/3/3 4/4/4\nf -4 -3 -2\n'));assert.equal(obj.length/9,3);
  assert.equal(parseModel('box.obj',new TextEncoder().encode('v 0 0 0\nv 2 0 0\nv 0 2 0\nf 1 2 3\n')).triangles,1);
  assert.ok(canRender('a.stl')&&canRender('B.OBJ')&&!canRender('c.glb')&&!canRender('stl'));
  assert.throws(()=>parseModel('none.stl',new TextEncoder().encode('solid x\nendsolid x')),/No triangles/);
  assert.throws(()=>parseStl(binaryStl([[0,0,0,1,0,0,0,1,0]]).slice(0,100)),/truncated|incomplete|No triangles/);
  assert.throws(()=>parseObj(new TextEncoder().encode('v 0 0 0\nf 1 2 3\n')),/missing vertex/);
  assert.throws(()=>buildMesh(new Float32Array([0,0,0,0,0,0,0,0,0])),/no size/);
  assert.throws(()=>parseModel('a.pdf',new ArrayBuffer(4)),/STL and OBJ/);
});
test('cloud client: Supabase REST calls, safe object names, listing, and actionable errors',async()=>{
  assert.match(SUPABASE_URL,/^https:\/\/[a-z0-9]+\.supabase\.co$/);assert.equal(CLOUD_BUCKET,'aeroform-models');
  assert.equal(storageName('../My Part (v2).STL',1700000000000),'1700000000000-My-Part-v2-.STL');assert.equal(displayName('1700000000000-house.stl'),'house.stl');
  const calls=[];let reply=()=>new Response('[]');
  const cloud=createCloud({fetch:async(url,options={})=>{calls.push({url,options});return reply(url);},url:'https://p.supabase.co',key:'sb_publishable_test',bucket:'b'});
  assert.equal(cloud.available,true);assert.equal(createCloud({}).available,false);
  const uploaded=await cloud.upload({name:'part.stl',type:'',size:4},1700000000000);
  assert.deepEqual(uploaded,{name:'1700000000000-part.stl',label:'part.stl'});
  assert.equal(calls[0].url,'https://p.supabase.co/storage/v1/object/b/1700000000000-part.stl');assert.equal(calls[0].options.method,'POST');
  assert.equal(calls[0].options.headers.apikey,'sb_publishable_test');assert.equal(calls[0].options.headers['Content-Type'],'application/octet-stream');assert.equal(calls[0].options.headers['x-upsert'],'false');
  reply=()=>new Response(JSON.stringify([{id:'1',name:'1700000000001-new.stl',metadata:{size:2048},created_at:'t'},{id:null,name:'folder'},{id:'2',name:'.emptyFolderPlaceholder'}]));
  assert.deepEqual(await cloud.list(),[{name:'1700000000001-new.stl',label:'new.stl',size:2048,created:'t'}]);
  assert.deepEqual(JSON.parse(calls[1].options.body).sortBy,{column:'created_at',order:'desc'});
  assert.equal(cloud.publicUrl('a b.stl'),'https://p.supabase.co/storage/v1/object/public/b/a%20b.stl');
  reply=()=>new Response(new Uint8Array([1,2,3]));assert.equal((await cloud.download('x.stl')).byteLength,3);
  reply=()=>new Response(JSON.stringify({statusCode:'404',error:'Bucket not found',message:'Bucket not found'}),{status:400});await assert.rejects(cloud.list(),/does not exist yet.*setup\.sql/);
  reply=()=>new Response(JSON.stringify({message:'new row violates row-level security policy'}),{status:400});await assert.rejects(cloud.upload({name:'a.stl',size:1}),/refused.*policies/);
  reply=()=>{throw new TypeError('Failed to fetch');};await assert.rejects(cloud.list(),/internet connection/);
});
test('actual cloud list renders names as text and loads a shared STL into the viewer',async()=>{
  const stl=new TextEncoder().encode(asciiStl);
  const fetch=async url=>url.includes('/list/')?new Response(JSON.stringify([{id:'1',name:'1700000000000-<b>part</b>.stl',metadata:{size:1500000}},{id:'2',name:'1700000000000-plan.pdf',metadata:{size:900}}])):new Response(stl);
  const h=await createAppHarness({fetch});await h.settle();await h.settle();
  const items=h.find('#cloud-list').children;assert.equal(items.length,2);
  const first=items[0].children[0];assert.equal(first.children[0].textContent,'<b>part</b>.stl');assert.equal(first.children[1].textContent,'1.4 MB · 3D');
  assert.equal(items[1].children[0].children[1].textContent,'1 KB · stored only');assert.match(h.find('#cloud-status').textContent,/2 files/);
  first.click();await h.settle();await h.settle();
  const info=h.win.aeroform.inspect();assert.equal(info.cloudModel,'<b>part</b>.stl');assert.equal(info.model.triangles,2);
  assert.equal(h.find('#demo-btn').hidden,false);assert.equal(h.find('#legend-label').textContent,'<b>part</b>.stl');
  h.click('#demo-btn');assert.equal(h.win.aeroform.inspect().model,null);assert.equal(h.find('#demo-btn').hidden,true);
  const offline=await createAppHarness();await h.settle();assert.match(offline.find('#cloud-status').textContent,/unavailable/);
});
test('ray picking: box entry distance, misses, boxes behind, and the camera inside a box',()=>{
  near(rayBox([0,0,10],[0,0,-1],[0,0,0],[2,2,2]),9);
  assert.equal(rayBox([0,5,10],[0,0,-1],[0,0,0],[2,2,2]),null);
  assert.equal(rayBox([0,0,10],[0,0,1],[0,0,0],[2,2,2]),null);
  assert.equal(rayBox([0,0,0],[0,0,-1],[0,0,0],[2,2,2]),null);
  near(rayBox([5,5,5],normalize([-1,-1,-1]),[0,0,0],[2,2,2]),Math.hypot(4,4,4));
});
test('pinch detection: palm-normalized ratio, hysteresis, hold frames, and lost hands',()=>{
  const hand=(gap,palm=0.2)=>Array.from({length:21},(_,i)=>i===0?{x:.5,y:.8,z:0}:i===9?{x:.5,y:.8-palm,z:0}:i===4?{x:.5,y:.5,z:0}:i===8?{x:.5+gap,y:.5,z:0}:{x:.5,y:.6,z:0});
  near(pinchRatio(hand(.1)),.5);near(pinchRatio(hand(.1,.4)),.25);near(pinchRatio(hand(.1),2),1);
  assert.equal(pinchRatio(null),null);assert.equal(pinchRatio(hand(.1,0)),null);
  const d=createPinchDetector({enter:.3,exit:.45,holdFrames:2,lostFrames:3});
  assert.equal(d.update(.2).started,false);assert.equal(d.update(.2).started,true);
  assert.equal(d.update(.4).pinched,true);assert.equal(d.update(.35).started,false);
  assert.equal(d.update(.5).ended,true);assert.equal(d.update(.2).started,false);assert.equal(d.update(.6).pinched,false);
  d.update(.1);d.update(.1);assert.equal(d.pinched,true);d.update(null);d.update(null);assert.equal(d.pinched,true);assert.equal(d.update(null).ended,true);
  // Alternating noise around the threshold never re-triggers a selection.
  const e=createPinchDetector();let starts=0;for(let i=0;i<60;i++)if(e.update(i%2?.28:.4).started)starts++;assert.equal(starts,0);
});
test('renderer: cloud model replaces the house; center pinch selects and highlights; reticle draws',()=>{
  const h=rendererHarness(),state={view:'interior',floor:'all',layer:'architecture',vr:false};
  h.viewer.update(state,'view');h.step();
  const before=h.calls.filter(c=>c[0]==='drawArrays').length;assert.ok(before>100);
  const hit=h.viewer.selectAtCenter();assert.ok(hit&&hit.name&&hit.distance>0);assert.equal(h.viewer.inspect().selected,hit.name);
  h.step();assert.ok(h.calls.some(c=>c[0]==='uniform3fv'&&c[1]==='uColor'&&c[2][0]===.62&&c[2][1]===.85&&c[2][2]===1));
  h.viewer.setReticle(true);h.step();assert.ok(h.calls.some(c=>c[0]==='drawArrays'&&c[1]===4&&c[3]===1));
  const mesh=parseModel('part.stl',new TextEncoder().encode(asciiStl));mesh.name='part.stl';h.viewer.setModel(mesh);h.step();
  const draws=h.calls.filter(c=>c[0]==='drawArrays');assert.deepEqual(draws.map(c=>c.slice(1)),[[3,0,6],[4,0,1]]);
  assert.equal(h.viewer.inspect().selected,null);assert.equal(h.viewer.inspect().model.triangles,2);
  near(h.viewer.inspect().orbit.target[1],MODEL_FIT_METRES/2);
  assert.equal(h.viewer.selectAtCenter().type,'model');
  h.viewer.update({...state,vr:true},'vr');assert.equal(h.viewer.nextRoom(),'part.stl');near(h.viewer.inspect().vrPosition[2],mesh.size[2]/2+4);
  h.viewer.setModel(null);h.step();assert.ok(h.calls.filter(c=>c[0]==='drawArrays').length>50);
});
test('actual hand-tracking button reports a missing camera and stays usable',async()=>{
  const h=await createAppHarness();
  h.click('#hands-btn');for(let i=0;i<5;i++)await h.settle();
  assert.match(h.find('#hands-status').textContent,/could not start|No camera/);assert.equal(h.find('#hands-btn').getAttribute('aria-pressed'),'false');
  assert.equal(h.find('#hand-preview').hidden,true);assert.equal(h.win.aeroform.inspect().handTracking,false);
});
test('actual startup failure shows retry and keeps help responsive; retry recovers when graphics return',async()=>{
  const h=await createAppHarness({graphics:false});assert.equal(h.doc.body.dataset.viewer,'error');assert.equal(h.find('#retry-btn').hidden,false);assert.equal(h.find('#vr-btn').disabled,true);
  h.click('#help-btn');assert.equal(h.find('#help-modal').open,true);h.click('#close-help');
  const healthy=await createAppHarness();const context=healthy.canvas.getContext();
  globalThis.document=h.doc;globalThis.window=h.win;h.canvas.getContext=()=>context;
  h.click('#retry-btn');await h.settle();assert.equal(h.doc.body.dataset.viewer,'ready');assert.equal(h.find('#vr-btn').disabled,false);
});

test('all local modules, cache entries, and HTML assets resolve without CDN dependencies',async()=>{
  const root=new URL('../',import.meta.url);const files=['app.js','src/viewer.js','src/viewer-state.js','src/vr-optics.js','src/math.js','src/building.js','src/mesh.js','src/cloud.js','src/hand-tracking.js','src/conditions.js','src/handnet.js','src/handnet-worker.js','src/hand-detector.js','src/mediapipe-detector.js','src/mediapipe-worker.js','src/gesture-classifier.js','src/locomotion.js','src/clap-detector.js','src/analysis-panel.js','src/analysis-charts.js','src/ai/registry.js','src/simulation/index.js','src/simulation/constructions.js','src/simulation/model.js','src/simulation/thermal.js','src/simulation/weather.js','src/simulation/optimizer.js','src/simulation/visualize.js','src/energy-surrogate.js','src/simulation/surrogate-features.js','src/simulation/energyplus.js'];
  for(const file of files){
    const source=await readFile(new URL(file,root),'utf8');assert.doesNotMatch(source,/https?:\/\/|from ['"]three/);
    for(const match of source.matchAll(/(?:from\s*|import\s*\(\s*)['"]([^'"]+)['"]/g))assert.ok((await readFile(new URL(match[1],new URL(file,root)))).length>0);
  }
  const html=await readFile(new URL('index.html',root),'utf8');assert.doesNotMatch(html,/`n|cdn\.jsdelivr|fonts\.google/);
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);assert.equal(ids.length,new Set(ids).size);
  for(const match of html.matchAll(/(?:src|href)="([^"]+)"/g)){if(match[1]==='./')continue;assert.ok((await readFile(new URL(match[1].split('?')[0],root))).length>0);}
  const app=await readFile(new URL('app.js',root),'utf8');for(const m of app.matchAll(/\$\('#([^']+)'\)/g))assert.ok(ids.includes(m[1]),`Missing element ${m[1]}`);
  const sw=await readFile(new URL('sw.js',root),'utf8');assert.match(sw,/startsWith\('aeroform-'\)/);assert.match(sw,/skipWaiting/);
  const assets=sw.match(/const ASSETS=(\[[^;]+\])/)[1];for(const asset of JSON.parse(assets.replaceAll("'",'"'))){const name=asset==='./'?'index.html':asset.split('?')[0];await readFile(new URL(name,root));}
});
test('HTTP server serves the app and module MIME types; rejects methods and private files',async()=>{
  const server=createServer();await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  const url=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const resource of ['/','/app.js?v=4','/src/viewer.js','/styles.css?v=4','/sw.js']){const res=await fetch(url+resource);assert.equal(res.status,200);assert.equal(res.headers.get('cache-control'),'no-store');assert.ok((await res.text()).length>100);}
    assert.match((await fetch(url+'/src/math.js')).headers.get('content-type'),/javascript/);
    for(const resource of ['/src/mesh.js','/src/cloud.js','/src/cloud-config.js','/src/hand-tracking.js'])assert.equal((await fetch(url+resource)).status,200);
    // Hand tracking: vendored MediaPipe is served locally with the right types; the HandNet experiment is not shipped.
    assert.match((await fetch(url+'/vendor/mediapipe/vision_bundle.mjs',{method:'HEAD'})).headers.get('content-type'),/javascript/);
    assert.equal((await fetch(url+'/vendor/mediapipe/wasm/vision_wasm_internal.wasm',{method:'HEAD'})).headers.get('content-type'),'application/wasm');
    assert.equal((await fetch(url+'/vendor/mediapipe/hand_landmarker.task',{method:'HEAD'})).status,200);
    for(const p of ['/src/handnet.js','/src/handnet-worker.js','/models/handnet.json'])assert.equal((await fetch(url+p,{method:'HEAD'})).status,404);
    assert.equal((await fetch(url+'/supabase/setup.sql')).status,404);
    for(const path of ['/package.json','/.apk-build/debug.keystore','/../README.md','/%2e%2e%2fREADME.md','/unknown'])assert.equal((await fetch(url+path)).status,404);
    assert.equal((await fetch(url+'/',{method:'POST'})).status,405);
    const head=await fetch(url+'/',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
  }finally{await new Promise(resolve=>server.close(resolve));}
});
test('weather conditions: presets, clamped edits, custom detection, and summaries',async()=>{
  const { normalizeConditions, applySeason, editCondition, describeConditions, DEFAULT_CONDITIONS } = await import('../src/conditions.js');
  assert.deepEqual(normalizeConditions(),{...DEFAULT_CONDITIONS});
  assert.deepEqual(applySeason('summer'),{season:'summer',temperature:32,wind:'S',windSpeed:3});
  assert.deepEqual(normalizeConditions({season:'nope',temperature:99,wind:'Q',windSpeed:-4}),{season:'custom',temperature:45,wind:'W',windSpeed:0});
  const edited=editCondition(applySeason('winter'),'temperature',2);assert.equal(edited.season,'custom');assert.equal(edited.temperature,2);
  assert.equal(editCondition(applySeason('winter'),'wind','N').season,'winter');
  assert.equal(describeConditions(applySeason('mild')),'Mild · 18 °C · wind W 4 m/s');
  assert.equal(describeConditions({season:'custom',temperature:7,wind:'E',windSpeed:2}),'Custom · 7 °C · wind E 2 m/s');
});
test('actual weather pill, sim card, local open and menu help controls work and persist',async()=>{
  const storage=new Map([['aeroform-conditions-v1','{"season":"summer","temperature":32,"wind":"S","windSpeed":3}']]);
  const h=await createAppHarness({storage});
  assert.equal(h.find('#conditions-summary').textContent,'Summer heat · 32 °C · wind S 3 m/s');assert.equal(h.find('#conditions-pill-summary').textContent,'Summer heat · 32 °C');
  h.click('#conditions-pill');assert.equal(h.find('#conditions-modal').open,true);
  h.click('[data-season="winter"]');assert.equal(h.find('[data-season="winter"]').getAttribute('aria-pressed'),'true');assert.equal(h.find('#cond-temperature').value,'-5');
  h.find('#cond-temperature').value='3';h.dispatch(h.find('#cond-temperature'),'input');assert.match(h.find('#conditions-summary').textContent,/^Custom · 3 °C/);
  h.click('[data-wind="E"]');assert.equal(JSON.parse(storage.get('aeroform-conditions-v1')).wind,'E');
  h.dispatch(h.win,'aeroform-back');assert.equal(h.find('#conditions-modal').open,false);
  h.click('#conditions-btn');assert.equal(h.find('#conditions-modal').open,true);h.click('#conditions-done');assert.equal(h.find('#conditions-modal').open,false);
  h.find('#local-upload').files=[{name:'plan.pdf',size:10}];h.dispatch(h.find('#local-upload'),'change');await h.settle();
  assert.match(h.find('#upload-error').textContent,/STL and OBJ/);
  const stl=new TextEncoder().encode(asciiStl);h.find('#local-upload').files=[{name:'local.stl',size:stl.length,arrayBuffer:async()=>stl.buffer}];
  h.dispatch(h.find('#local-upload'),'change');await h.settle();
  assert.equal(h.win.aeroform.inspect().cloudModel,'local.stl');assert.match(h.find('#upload-description').textContent,/this device only/);
  h.click('#panel-btn');h.click('#menu-help-btn');assert.equal(h.find('#help-modal').open,true);assert.equal(h.find('#sidebar').classList.contains('open'),false);
});

test('trained gesture model: JS features and inference reproduce the Python export; commands need a held gesture',async()=>{
  const { createGestureClassifier, gestureFeatures, createGestureCommands } = await import('../src/gesture-classifier.js');
  const model=JSON.parse(await readFile(new URL('../models/gesture-classifier.json',import.meta.url),'utf8'));
  const classifier=createGestureClassifier(model);
  assert.deepEqual(classifier.classes,['open_palm','fist','point','thumbs_up','thumbs_down','ok','two_fingers','three_fingers','four_fingers','other']);
  // Every sign used in VR is recognised on held-out people.
  for(const c of ['point','two_fingers','three_fingers','four_fingers','thumbs_up','thumbs_down','open_palm'])assert.ok(model.metrics.hagrid_test.classes[c].recall>.95&&model.metrics.hagrid_test.classes[c].precision>.9,c);
  assert.ok(model.checks.length>=5);
  for(const check of model.checks){
    const p=classifier.probabilities(gestureFeatures(check.points));
    check.probabilities.forEach((expected,i)=>assert.ok(Math.abs(p[i]-expected)<2e-4,`class ${i}: ${p[i]} vs ${expected}`));
  }
  assert.ok(model.metrics.hagrid_test.accuracy>.95);
  // Mirroring: a left hand (x flipped) gets the same features as the right hand.
  const pts=model.checks[0].points,mirrored=pts.map(([x,y])=>[1-x,y]);
  const a=gestureFeatures(pts),b=gestureFeatures(mirrored);a.forEach((v,i)=>near(v,b[i],1e-9));
  // Translation and scale do not matter; {x,y} objects work like [x,y] pairs.
  const moved=gestureFeatures(pts.map(([x,y])=>({x:x*.5+.2,y:y*.5+.1})));a.forEach((v,i)=>near(v,moved[i],1e-9));
  assert.equal(gestureFeatures([[0,0]]),null);assert.throws(()=>createGestureClassifier({format:'x'}),/Unsupported/);
  // Held signs: fire once after holdMs; a short dropout does not restart the hold; a new sign or a long gap re-arms.
  const commands=createGestureCommands({holdMs:400,graceMs:250});const fist={label:'fist',confidence:.95};
  assert.equal(commands.update(fist,0),null);assert.equal(commands.update(fist,200),null);
  assert.equal(commands.update(null,300),null,'blurred frame');assert.equal(commands.update({label:'fist',confidence:.4},350),null);
  assert.equal(commands.update(fist,400),'fist');assert.deepEqual(commands.state,{label:'fist',progress:1,fired:true});
  assert.equal(commands.update(fist,900),null,'held on: fires once');
  assert.equal(commands.update(null,1300),null);assert.equal(commands.state.label,null,'gone longer than graceMs');
  assert.equal(commands.update(fist,1400),null);assert.equal(commands.update(fist,1800),'fist');
  assert.equal(commands.update({label:'thumbs_down',confidence:.9},1850),null);assert.equal(commands.update({label:'thumbs_down',confidence:.9},2250),'thumbs_down');
  // Flicker that never lasts the hold does nothing; open palm (walk), OK and other are not commands.
  const c2=createGestureCommands({holdMs:400});
  for(let t=0;t<2000;t+=33)assert.equal(c2.update({label:t%200<100?'point':'two_fingers',confidence:.9},t),null);
  for(const label of ['open_palm','ok','other'])for(let t=3000;t<4000;t+=33)assert.equal(c2.update({label,confidence:.99},t),null);
});

test('hand dev view: opens from the menu and stays open in VR, explains a missing camera, switches camera, and shows the log',async()=>{
  const storage=new Map();const h=await createAppHarness({storage});
  h.click('#hand-dev-open');assert.equal(h.find('#hand-dev').hidden,false);assert.equal(storage.get('aeroform-hand-dev'),'1');
  assert.match(h.find('#hand-dev-hint').textContent,/Start tracking/);assert.equal(h.find('#hand-dev-camera').textContent,'Camera: rear');
  h.click('#hand-dev-camera');await h.settle();assert.equal(h.find('#hand-dev-camera').textContent,'Camera: front');assert.equal(storage.get('aeroform-hand-camera'),'user');
  h.click('#hand-dev-toggle');for(let i=0;i<5;i++)await h.settle();h.click('#hand-dev-camera');await h.settle();
  assert.equal(h.find('#hand-dev-state').textContent,'error');assert.match(h.find('#hand-dev-hint').textContent,/No camera/);
  assert.ok(h.find('#hand-dev-log').children.some(li=>/Starting front camera/.test(li.textContent)));
  h.click('#hand-dev-close');assert.equal(h.find('#hand-dev').hidden,true);assert.equal(storage.get('aeroform-hand-dev'),'0');
  h.click('#hand-dev-open');h.click('#vr-btn');assert.equal(h.find('#hand-dev').hidden,false);assert.equal(h.win.aeroform.inspect().handDev,true);
});
test('walking: steps from a walking signal move you; single bumps, sitting noise and slow sway do not',async()=>{
  const { createStepDetector, STEP_LENGTH_METRES } = await import('../src/locomotion.js');
  const run=(signal,ms=6000,rate=50)=>{const d=createStepDetector();let steps=0;for(let t=0;t<=ms;t+=1000/rate)steps+=d.update(signal(t),t);return {steps,walking:d.walking};};
  // 1.8 steps/s with a 3 m/s^2 bounce: about 10 steps in 6 s (the first is confirmed by the second).
  const walk=run(t=>3*Math.max(0,Math.sin(2*Math.PI*1.8*t/1000)));assert.ok(walk.steps>=9&&walk.steps<=11,String(walk.steps));
  assert.equal(run(t=>t>1000&&t<1100?4:0).steps,0);
  assert.equal(run(t=>.3*Math.sin(t/37)+.2*Math.sin(t/11)).steps,0);
  assert.equal(run(t=>3*Math.max(0,Math.sin(2*Math.PI*.3*t/1000))).steps,0);
  assert.equal(STEP_LENGTH_METRES,.7);
});
test('open hand and grab offsets: geometry works for palm or back of hand, mirrored front camera',async()=>{
  const { isOpenHand, grabOffset, palmSize } = await import('../src/locomotion.js');
  const hand=(curl=0,cx=.5,scale=1)=>Array.from({length:21},(_,i)=>{const finger=Math.floor((i-1)/4),joint=(i-1)%4;if(i===0)return{x:cx,y:.8};
    const x=cx+(finger-1.5)*.04*scale,base=.8-.12*scale,len=joint*.05*scale*(finger===0?.6:1);return{x,y:finger===0?base+.02:base-len*(joint===3&&curl?-1:1)};});
  assert.equal(isOpenHand(hand(0)),true);assert.equal(isOpenHand(hand(1)),false);assert.equal(isOpenHand(null),false);
  const start=hand(0),moved=hand(0,.6),far=hand(0,.5,.5);
  const right=grabOffset(start,moved,{distance:3});assert.ok(right.right>0&&Math.abs(right.up)<1e-9&&Math.abs(right.forward)<1e-9);
  assert.ok(grabOffset(start,moved,{distance:3,mirrored:true}).right<0);
  near(grabOffset(start,moved,{distance:3}).right,.1*2*Math.tan(Math.PI/6)*3);
  const push=grabOffset(start,far,{distance:3});near(push.forward,3);near(palmSize(far)/palmSize(start),.5);
  assert.deepEqual(grabOffset(null,moved),{right:0,up:0,forward:0});
});
test('renderer: walking moves level in the look direction; grabbing the AC moves its whole group and saves offsets',()=>{
  const h=rendererHarness();h.viewer.update({view:'interior',floor:'all',layer:'architecture',vr:true},'vr');h.step();
  const before=h.viewer.inspect().vrPosition;h.viewer.moveForward(2);const after=h.viewer.inspect().vrPosition;
  near(after[2],before[2]-2);near(after[1],before[1]);
  // Stand in front of the floor-1 AC unit and look at it.
  h.viewer.goTo([4.4,2.4,-2.9],[5.76,2.4,-2.9]);h.step();
  const grabbed=h.viewer.beginGrab();assert.equal(grabbed.name,'AC unit');assert.equal(grabbed.group,'ac-1');assert.equal(h.viewer.inspect().grabbing,'ac-1');
  h.viewer.updateGrab({right:0,up:0,forward:-.5});
  const done=h.viewer.endGrab();assert.equal(done.group,'ac-1');near(done.offset[0],-.5,1e-6);near(done.offset[1],0,1e-6);
  assert.equal(h.viewer.inspect().grabbing,null);
  // Dropping below the floor is prevented.
  h.viewer.goTo([4.4,2.4,-2.9],[5.76+done.offset[0],2.4,-2.9]);assert.ok(h.viewer.beginGrab());const low=h.viewer.updateGrab({up:-10});assert.ok(low.position[1]>=.3-1e-9);h.viewer.endGrab();
  h.viewer.applyMoves({});h.viewer.goTo([4.4,2.4,-2.9],[5.76,2.4,-2.9]);assert.equal(h.viewer.beginGrab().group,'ac-1');h.viewer.endGrab();
  // Fixed things are not grabbed.
  h.viewer.goTo([0,1.65,3.6],[-6,1.65,3.6]);assert.equal(h.viewer.beginGrab(),null);
  assert.deepEqual(h.viewer.movableGroups().sort(),['ac-1','ac-2','vent-1','vent-2']);
});
test('fist then open hand toggles once; open without a fist, or too late, does nothing',async()=>{
  const { createFistOpenToggle } = await import('../src/gesture-classifier.js');
  const t=createFistOpenToggle({fistFrames:3,window:1000});let time=0;const f=s=>t.update(s,time+=33);
  for(let i=0;i<5;i++)assert.equal(f('open'),false);
  for(let i=0;i<4;i++)f('fist');assert.equal(f(null),false);assert.equal(f('open'),true);assert.equal(f('open'),false);
  for(let i=0;i<4;i++)f('fist');time+=1500;assert.equal(f('open'),false);
  f('fist');assert.equal(f('open'),false);
});
test('actual walk toggle and reset moved items controls persist',async()=>{
  const storage=new Map([['aeroform-moves-v1','{"ac-1":[-1,0,0]}']]);const h=await createAppHarness({storage});
  assert.deepEqual(h.win.aeroform.inspect().moves,{'ac-1':[-1,0,0]});
  // Walk in VR is a menu toggle (no buttons in VR).
  assert.equal(h.find('#vr-walk-btn').getAttribute('aria-pressed'),'true');assert.match(h.find('#vr-walk-status').textContent,/^On/);
  h.click('#vr-walk-btn');assert.equal(storage.get('aeroform-walk'),'0');assert.equal(h.find('#vr-walk-btn').getAttribute('aria-pressed'),'false');assert.equal(h.find('#vr-walk-status').textContent,'Off');h.click('#vr-btn');
  h.dispatch(h.win,'aeroform-back');h.click('#reset-moves-btn');assert.equal(storage.get('aeroform-moves-v1'),'{}');
  // Accelerometer batches from the Android app drive the step detector.
  h.click('#vr-walk-btn');h.click('#vr-btn');const batch=[];for(let t=0;t<=4000;t+=20)batch.push([t,3*Math.max(0,Math.sin(2*Math.PI*1.8*t/1000))]);
  h.dispatch(h.win,'aeroform-motion',{detail:batch});assert.ok(h.win.aeroform.inspect().walk.steps>=5);
});

const sim=await import('../src/simulation/index.js');
const { buildThermalModel, acPlacement } = await import('../src/simulation/model.js');
const { simulate } = await import('../src/simulation/thermal.js');
const { designDay, sunPosition } = await import('../src/simulation/weather.js');
const { buildVisualization } = await import('../src/simulation/visualize.js');
const { applySeason: season } = await import('../src/conditions.js');
test('simulation geometry: zones tile each floor, openings match the 3D windows, HVAC assigned by position',()=>{
  const m=buildThermalModel(building,sim.DEFAULT_DESIGN);
  assert.equal(m.zones.length,6);for(const level of [1,2])near(m.zones.filter(z=>z.level===level).reduce((s,z)=>s+z.area,0),108,1e-9);
  const glass=m.zones.flatMap(z=>z.surfaces).filter(s=>s.type==='window').reduce((s,x)=>s+x.area,0);
  const modelled=building.boxes.filter(b=>b.name==='north window'||b.name==='south glazing').reduce((s,b)=>s+b.size[0]*b.size[1],0);
  near(glass,modelled,1e-6);
  assert.ok(m.zones.filter(z=>z.level===2).every(z=>z.surfaces.some(s=>s.type==='roof')));assert.ok(m.zones.filter(z=>z.level===1).every(z=>z.surfaces.some(s=>s.type==='floor')));
  // Demo starting layout: AC units in the bedrooms (deliberately poor), vents in the hall.
  assert.deepEqual(m.devices.map(d=>d.group+'>'+d.zoneId).sort(),['ac-1>bedroom-1','ac-2>bedroom-2','vent-1>hall-1','vent-2>hall-2']);
  const target=acPlacement(m,'bedroom-1'),home=building.boxes.find(b=>b.group==='ac-1'&&b.type==='ac').home;
  const moved=buildThermalModel(building,sim.DEFAULT_DESIGN,{'ac-1':target.map((v,k)=>v-home[k])});
  assert.equal(moved.devices.find(d=>d.group==='ac-1').zoneId,'bedroom-1');
  assert.equal(buildThermalModel(building,sim.DEFAULT_DESIGN,{'ac-1':[20,0,0]}).devices.find(d=>d.group==='ac-1').zoneId,null);
});
test('simulation physics: energy balance closes over the day and every design change moves results the right way',()=>{
  const run=(design,c='winter',moves={})=>{const d=sim.normalizeDesign(design);return simulate(buildThermalModel(building,d,moves),designDay(season(c),d),d,{days:6});};
  for(const c of ['winter','summer']){
    const r=run(sim.DEFAULT_DESIGN,c);
    const gains=Object.values(r.breakdown).reduce((s,v)=>s+v.gainKWh,0)+r.totals.heatingKWh,losses=Object.values(r.breakdown).reduce((s,v)=>s+v.lossKWh,0)+r.totals.coolingKWh;
    assert.ok(Math.abs(gains-losses)<0.02*(gains+losses),`${c}: gains ${gains} vs losses ${losses}`);
  }
  const base=run(sim.DEFAULT_DESIGN),triple=run({...sim.DEFAULT_DESIGN,windows:'triple'});
  assert.ok(triple.breakdown.windows.lossKWh<base.breakdown.windows.lossKWh*.5);assert.ok(triple.breakdown.solar.gainKWh<base.breakdown.solar.gainKWh);
  assert.ok(run({...sim.DEFAULT_DESIGN,airtightness:'tight'}).breakdown.infiltration.lossKWh<base.breakdown.infiltration.lossKWh*.5);
  assert.ok(run({...sim.DEFAULT_DESIGN,heatRecovery:'hrv'}).breakdown.ventilation.lossKWh<base.breakdown.ventilation.lossKWh*.4);
  assert.ok(run({...sim.DEFAULT_DESIGN,walls:'high'}).breakdown.walls.lossKWh<base.breakdown.walls.lossKWh);
  assert.ok(run({...sim.DEFAULT_DESIGN,heatSetpoint:22}).totals.heatingKWh>base.totals.heatingKWh);
  const summer=run(sim.DEFAULT_DESIGN,'summer');assert.equal(summer.totals.heatingKWh,0);assert.ok(summer.totals.coolingKWh>0);
  assert.ok(base.zones.filter(z=>!z.acUnits).every(z=>z.heatingKWh===0));
  const noAc=run(sim.DEFAULT_DESIGN,'winter',{'ac-1':[20,0,0],'ac-2':[20,0,0]});assert.equal(noAc.totals.heatingKWh,0);assert.ok(noAc.devices.filter(d=>d.type==='ac').every(d=>d.outside));
  near(base.totals.electricKWh,base.totals.heatingKWh/3+base.totals.coolingKWh/3.2,1e-9);near(base.totals.co2Kg,base.totals.electricKWh*.38,1e-9);
  assert.ok(base.zones.every(z=>z.hourlyC.length===24&&z.minC<=z.meanC&&z.meanC<=z.maxC));
});
test('weather: sun angles at 45 N and facade sunlight follow the season',()=>{
  const noonSummer=sunPosition(45,196,12),noonWinter=sunPosition(45,15,12);
  near(noonSummer.altitude*180/Math.PI,90-45+21.2,1);near(noonWinter.altitude*180/Math.PI,90-45-21.3,1);near(noonWinter.azimuth,0,1e-6);
  const w=designDay(season('winter'),{latitude:45}),s=designDay(season('summer'),{latitude:45});
  assert.ok(w.hours[12].solar.south>s.hours[12].solar.south);assert.ok(s.hours[12].solar.roof>w.hours[12].solar.roof);
  assert.ok(w.hours[8].solar.east>w.hours[8].solar.west);assert.ok(w.hours.every(h=>h.hour<6||h.hour>18?h.solar.south===0:true));
  near(w.hours.reduce((a,h)=>a+h.outdoor,0)/24,-5,1e-9);assert.ok(w.hours[14].outdoor>w.hours[4].outdoor);
  const south=designDay(season('summer'),{latitude:-35});assert.equal(south.dayOfYear,(196+182)%365);
});
test('optimizer: every listed improvement was simulated; trade-offs kept apart; applying a move relocates the AC',()=>{
  const r=sim.findImprovements({building,design:sim.DEFAULT_DESIGN,seasonConditions:['winter','mild','summer'].map(season)});
  assert.ok(r.energy.length>=5);assert.ok(r.energy.every(x=>x.savedKWh>0&&x.comfortGainKh>=-5&&x.kind!=='setpoint'));
  assert.ok(r.energy.every((x,i,a)=>i===0||a[i-1].savedKWh>=x.savedKWh));
  assert.ok(r.tradeoffs.every(x=>x.kind==='setpoint'||x.comfortGainKh<-5));
  assert.ok(r.package.savedKWh>=r.energy[0].savedKWh);assert.ok(new Set(r.package.candidates.map(c=>c.category)).size===r.package.candidates.length);
  const move=[...r.energy,...r.comfort,...r.tradeoffs].find(x=>x.kind==='move');assert.ok(move);
  const applied=sim.applyImprovement(sim.DEFAULT_DESIGN,{},move);assert.ok(Array.isArray(applied.moves[move.group]));
  assert.notEqual(buildThermalModel(building,sim.DEFAULT_DESIGN,applied.moves).devices.find(d=>d.group===move.group).zoneId,'bedroom-'+move.group.split('-')[1]);
  const f=sim.findings(sim.analyze({building,design:sim.DEFAULT_DESIGN,conditions:season('winter')}).result);
  assert.ok(f.some(x=>/Largest heat loss/.test(x.text)));assert.ok(f.some(x=>/has no AC/.test(x.text)));
  const a=sim.analyze({building,design:sim.DEFAULT_DESIGN,conditions:season('mild')});
  assert.match(a.result.provenance.kind,/not EnergyPlus, not CFD, not AI/);assert.ok(a.result.provenance.assumptions.length>=6);assert.ok(a.result.provenance.inputs.windows.includes('U 2.8'));
});
test('visualization: tiles per room, windows lose more heat per m2 than walls in winter, jets follow moved devices',()=>{
  const {result}=sim.analyze({building,design:sim.DEFAULT_DESIGN,conditions:season('winter')});
  const v=buildVisualization(result,building,{},null);
  assert.equal(v.thermal.tiles.length,8);assert.ok(v.thermal.tiles.every(t=>t.color.length===3&&t.floor));
  const win=v.heatloss.fluxes.filter(x=>x.type==='window'),wall=v.heatloss.fluxes.filter(x=>x.type==='wall');
  assert.ok(Math.min(...win.map(x=>x.wPerM2))>Math.max(...wall.map(x=>x.wPerM2)));
  assert.ok(Object.keys(v.heatloss.recolor).length>20);
  const kinds=v.airflow.streams.map(st=>st.kind);
  assert.equal(kinds.filter(k=>k==='ac').length,4);assert.equal(kinds.filter(k=>k==='fresh').length,6);assert.equal(kinds.filter(k=>k==='stair').length,1);
  // Winter preset wind is from the north: outside air enters through the three north windows on each floor and leaves on the south.
  const outside=v.airflow.streams.filter(st=>st.kind==='outside');assert.equal(outside.length,6);
  assert.ok(outside.every(st=>st.points[0][2]<-4.5&&st.points.at(-1)[2]>4.5));
  // Winter: AC heating air loops along the ceiling (warm air rises); the stair carries warm air up.
  assert.ok(v.airflow.streams.filter(st=>st.kind==='ac').every(st=>st.points[2][1]%3.45>2.5));
  const stair=v.airflow.streams.find(st=>st.kind==='stair');assert.ok(stair.points[0][1]<stair.points.at(-1)[1]);
  // Routes only cross between rooms at the doorways: no straight segment crosses the living-room partition (x=-1.6) except at the doorway.
  for(const st of v.airflow.streams.filter(s=>s.floor))for(let i=1;i<st.points.length;i++){const a=st.points[i-1],b=st.points[i];
    if((a[0]+1.6)*(b[0]+1.6)<0){const f=(-1.6-a[0])/(b[0]-a[0]),z=a[2]+(b[2]-a[2])*f;assert.ok(z>1.0||Math.abs(a[2])>4.4,'crosses partition at z='+z);}}
  assert.ok(v.airflow.streams.every(st=>st.total>0&&st.lengths.length===st.points.length));
  const hourly=buildVisualization(result,building,{},6);assert.match(hourly.thermal.legend,/06:00/);
  const away=sim.analyze({building,design:sim.DEFAULT_DESIGN,moves:{'ac-1':[20,0,0]},conditions:season('winter')}).result;
  assert.equal(buildVisualization(away,building,{'ac-1':[20,0,0]}).airflow.streams.filter(st=>st.kind==='ac').length,2);assert.ok(sim.findings(away).some(x=>/outside the building/.test(x.text)));
});
test('renderer: heat-loss layer recolors envelope boxes; airflow uses simulated jets',()=>{
  const h=rendererHarness();const state={view:'interior',floor:'all',layer:'heatloss',vr:false};
  const {result}=sim.analyze({building,design:sim.DEFAULT_DESIGN,conditions:season('winter')});const v=buildVisualization(result,building);
  h.viewer.setAnalysis(v);h.viewer.update(state,'layer');h.step();
  const colors=h.calls.filter(c=>c[0]==='uniform3fv'&&c[1]==='uColor').map(c=>JSON.stringify([...c[2]]));
  const someWindow=building.boxes.find(b=>b.name==='north window').id;assert.ok(colors.includes(JSON.stringify(v.heatloss.recolor[someWindow])));
  h.viewer.update({...state,layer:'airflow'},'layer');h.step();
  const pointDraws=h.calls.filter(c=>c[0]==='drawArrays'&&c[1]===4&&c[3]>1);
  assert.equal(pointDraws.reduce((s,c)=>s+c[3],0),3*v.airflow.streams.reduce((s,st)=>s+st.count,0));
  assert.ok(h.calls.some(c=>c[0]==='uniform1f'&&c[1]==='uPointSize'&&c[2]===270));
});
test('heat particles: winter heat escapes out through every window and the door, a heatwave pushes it in; thermal has none',()=>{
  const winter=buildVisualization(sim.analyze({building,design:sim.DEFAULT_DESIGN,conditions:season('winter')}).result,building);
  const leaks=winter.heatloss.streams;assert.ok(leaks.length>0&&leaks.every(st=>st.kind==='heat'&&st.total>0));
  // Five windows and a door per floor, six lanes each; every lane starts inside the walls and ends outside them, higher up.
  assert.equal(leaks.length,2*6*6);
  const inside=p=>Math.abs(p[2])<4.5&&Math.abs(p[0])<6;
  assert.ok(leaks.every(st=>inside(st.points[0])&&!inside(st.points.at(-1))&&st.points.at(-1)[1]>st.points[0][1]));
  // More heat flow, more particles: windows (U 2.8) carry more per lane than the door.
  const per=type=>Math.max(...leaks.filter(st=>Math.abs(st.points[1][2])>4.4&&(type==='door'?Math.abs(st.points[1][0]+1.3)<.7:Math.abs(st.points[1][0]+1.3)>.7)).map(st=>st.count));
  assert.ok(per('window')>=per('door'));
  // 45 °C outside: hotter than every room, so heat comes in everywhere. (At 40 °C the sun can push a room with
  // no AC above the outdoor mean, and heat then leaves through its windows, as the simulation says.)
  const hot=buildVisualization(sim.analyze({building,design:sim.DEFAULT_DESIGN,conditions:{season:'custom',temperature:45,wind:'S',windSpeed:2}}).result,building);
  assert.ok(hot.heatloss.streams.length>0&&hot.heatloss.streams.every(st=>!inside(st.points[0])&&inside(st.points.at(-1))),'heat comes in');
  // Thermal is room floors only (no particles).
  assert.equal(winter.thermal.clusters,undefined);assert.equal(winter.thermal.streams,undefined);assert.equal(winter.thermal.tiles.length,8);
});
test('renderer: thermal layer draws coloured floors and no particles, heat-loss layer draws heat leaving through the windows',()=>{
  const h=rendererHarness();const {result}=sim.analyze({building,design:sim.DEFAULT_DESIGN,conditions:season('winter')});const v=buildVisualization(result,building);
  h.viewer.setAnalysis(v);h.viewer.update({view:'interior',floor:'all',layer:'thermal',vr:false},'layer');h.step();
  const points=()=>h.calls.filter(c=>c[0]==='drawArrays'&&c[1]===4&&c[3]>1).reduce((s,c)=>s+c[3],0);
  assert.equal(points(),0,'no particles on Thermal');
  const tileColors=h.calls.filter(c=>c[0]==='uniform3fv'&&c[1]==='uColor').map(c=>JSON.stringify([...c[2]]));
  for(const tile of v.thermal.tiles)assert.ok(tileColors.includes(JSON.stringify(tile.color)),'floor tile drawn');
  h.calls.length=0;h.viewer.update({view:'interior',floor:'all',layer:'heatloss',vr:false},'layer');h.step();
  assert.equal(points(),3*v.heatloss.streams.reduce((s,st)=>s+st.count,0));
  h.calls.length=0;h.viewer.update({view:'interior',floor:'1',layer:'heatloss',vr:false},'layer');h.step();
  assert.equal(points(),3*v.heatloss.streams.filter(st=>st.floor===1).reduce((s,st)=>s+st.count,0),'floor filter applies');
});
test('renderer: VR draws half as many particles at half the size, capped at 12 px',async()=>{
  const { VR_PARTICLES } = await import('../src/viewer.js');assert.deepEqual({...VR_PARTICLES},{keep:2,size:.5,maxPixels:12});
  const h=rendererHarness();const {result}=sim.analyze({building,design:sim.DEFAULT_DESIGN,conditions:season('winter')});h.viewer.setAnalysis(buildVisualization(result,building));
  const measure=vr=>{h.calls.length=0;h.viewer.update({view:'interior',floor:'all',layer:'heatloss',vr},'layer');h.step();
    const draws=h.calls.filter(c=>c[0]==='drawArrays'&&c[1]===4&&c[3]>1),sizes=h.calls.filter(c=>c[0]==='uniform1f'&&c[1]==='uPointSize').map(c=>c[2]);
    const max=h.calls.filter(c=>c[0]==='uniform1f'&&c[1]==='uPointMax').map(c=>c[2]);
    return {points:draws.reduce((s,c)=>s+c[3],0),passes:max.length,biggest:Math.max(...sizes),max:max.at(-1)};};
  const flat=measure(false),vr=measure(true);
  assert.equal(flat.max,30);assert.equal(vr.max,12);
  assert.ok(Math.abs(vr.points/vr.passes/(flat.points/flat.passes)-.5)<.05,`${vr.points}/${vr.passes} vs ${flat.points}/${flat.passes}`);
  assert.equal(vr.biggest,flat.biggest/2);
});
test('demo layout: AC units start in the bedrooms; findings flag it and the optimizer finds a better spot for each',async()=>{
  const seasons=['winter','mild','summer'].map(season);
  // Flagged on every preset day, once per floor, before the per-room lines (so the panel's first four include it).
  for(const day of seasons){const f=sim.findings(sim.analyze({building,design:sim.DEFAULT_DESIGN,conditions:day}).result);
    const placement=f.filter(x=>/^The AC unit \(floor \d\) is in the bedroom/.test(x.text));assert.equal(placement.length,2,day.season);
    assert.ok(f.indexOf(placement[0])<f.findIndex(x=>/has no AC/.test(x.text)));}
  const r=sim.findImprovements({building,design:sim.DEFAULT_DESIGN,moves:{},seasonConditions:seasons});
  for(const group of ['ac-1','ac-2']){
    const best=r.comfort.find(x=>x.kind==='move'&&x.group===group);assert.ok(best,group+' move found');
    assert.match(best.label,/into the hall & dining/);assert.ok(best.comfortGainKh>100,group+' gain '+best.comfortGainKh);
    // Applying it moves the unit out of the bedroom and the finding goes away for that floor.
    const applied=sim.applyImprovement(sim.DEFAULT_DESIGN,{},best);const level=group.split('-')[1];
    const after=sim.findings(sim.analyze({building,design:sim.DEFAULT_DESIGN,moves:applied.moves,conditions:seasons[1]}).result);
    assert.ok(!after.some(x=>x.text.startsWith(`The AC unit (floor ${level})`)),'fixed on floor '+level);
  }
  // With both units in the hall the placement finding is gone and no better AC spot is offered for comfort.
  const both=['ac-1','ac-2'].reduce((m,g)=>sim.applyImprovement(sim.DEFAULT_DESIGN,m,r.comfort.find(x=>x.kind==='move'&&x.group===g)).moves,{});
  assert.ok(!sim.findings(sim.analyze({building,design:sim.DEFAULT_DESIGN,moves:both,conditions:seasons[1]}).result).some(x=>/^The AC unit/.test(x.text)));
});
test('actual analysis panel: runs on start, edits design, finds and applies improvements, compares with baseline',async()=>{
  const storage=new Map();const h=await createAppHarness({storage});
  assert.match(h.find('#analysis-summary').textContent,/kWh electricity/);assert.ok(h.win.aeroform.inspect().analysis.zones===6);
  h.click('#analysis-btn');assert.equal(h.find('#analysis-modal').open,true);
  assert.equal(h.doc.querySelector('#analysis-rooms'),null);assert.equal(h.doc.querySelector('#analysis-assumptions'),null);assert.ok(Number(h.find('#ak-electric').textContent)>0);
  assert.ok(h.find('#analysis-findings').children.length>=1&&h.find('#analysis-findings').children.length<=4);
  assert.equal(h.doc.querySelector('#analysis-models'),null);assert.match(h.find('#analysis-plan').innerHTML,/<svg/);assert.match(h.find('#analysis-chart').innerHTML,/<svg/);
  assert.match(h.find('#ak-comfort').textContent,/of 6/);assert.match(h.find('#analysis-flows-title').textContent,/Biggest heat/);
  h.click('#analysis-baseline');assert.ok(JSON.parse(storage.get('aeroform-baseline-v1')).design.windows);
  h.find('#design-windows').value='triple';h.dispatch(h.find('#design-windows'),'change');
  assert.equal(JSON.parse(storage.get('aeroform-design-v1')).windows,'triple');
  assert.match(h.find('#analysis-compare').children[1].children[0].textContent,/Electricity: .* → .*%\)/);
  h.click('[data-analysis-season="summer"]');assert.equal(h.win.aeroform.inspect().analysis.season,'summer');
  h.click('#analysis-optimize');assert.ok(h.find('#analysis-improvements').children.length>3);
  // Move equipment: one row per AC unit, saying what moving it does; Apply moves that unit.
  const heads=h.find('#analysis-improvements').children.filter(n=>n.tagName==='H4').map(n=>n.textContent);assert.ok(heads.includes('Move equipment'),heads.join('|'));
  const moveList=h.find('#analysis-improvements').children[h.find('#analysis-improvements').children.findIndex(n=>n.textContent==='Move equipment')+1];
  assert.equal(moveList.children.length,2);assert.match(moveList.children[0].children[0].textContent,/Move the floor \d AC unit into the/);
  assert.match(moveList.children[0].children[2].textContent,/fewer degree-hours too hot or cold · [+−]\d+% electricity/);
  // No setpoint change is presented as a comfort improvement.
  const oneAtATime=h.find('#analysis-improvements').children[h.find('#analysis-improvements').children.findIndex(n=>n.textContent==='One change at a time')+1];
  assert.ok(oneAtATime.children.every(li=>!/setpoint/i.test(li.children[0].textContent)));
  const apply=h.doc.querySelector('[data-apply="package:0"]');assert.ok(apply);apply.click();
  assert.match(h.find('#analysis-improvements').children.map(c=>c.textContent).join(' '),/Applied the best combination/);
  h.click('[data-layer="heatloss"]');assert.match(h.find('#legend-label').textContent,/Heat (coming in|leaking out)/);assert.equal(h.find('#simulation-note').hidden,false);
  h.dispatch(h.win,'aeroform-back');assert.equal(h.find('#analysis-modal').open,false);
});

test('analysis charts: plans, temperature chart, readout and bars are built from results; text is escaped',async()=>{
  const charts=await import('../src/analysis-charts.js');
  const {result}=sim.analyze({building,design:sim.DEFAULT_DESIGN,conditions:season('winter')});
  const plan=charts.floorPlanSvg(result,building);
  assert.equal((plan.match(/<rect [^>]*stroke-width="2"><title>[^<]*°C mean/g)||[]).length,8,'one tile per room');assert.doesNotMatch(plan,/ rx=/,'square corners');assert.match(plan,/Floor 1/);assert.match(plan,/Floor 2/);assert.match(plan,/no AC/);
  assert.equal((plan.match(/<title>AC unit<\/title>/g)||[]).length,2);
  const stacked=charts.floorPlanSvg(result,building,{stacked:true});assert.match(stacked,/viewBox="0 0 240 /);
  const narrow=charts.temperatureChartSvg(result,1,null,{width:340});assert.match(narrow.svg,/viewBox="0 0 340 200"/);assert.ok(!/06:00/.test(narrow.svg));
  const {svg,plot}=charts.temperatureChartSvg(result,1,null);
  assert.equal((svg.match(/<path /g)||[]).length,4);assert.match(svg,/comfort 20–25 °C/);assert.ok(plot.left>0&&plot.width>0&&plot.left+plot.width<1);
  assert.equal((charts.temperatureChartSvg(result,1,15).svg.match(/<circle /g)||[]).length,3);
  assert.match(charts.readout(result,1,15),/^15:00 · Living .* °C · Bedroom .* · Hall .* · Outdoor/);assert.match(charts.readout(result,1,null),/daily mean/);
  assert.match(charts.barListHtml([{label:'<b>x</b>',value:2,text:'2'}],'#fff'),/&lt;b&gt;x&lt;\/b&gt;/);
  // Diverging scale: grey inside the comfort band, blue colder, red hotter.
  assert.deepEqual(charts.comfortColor(22,20,25),charts.comfortColor(24,20,25));
  const cold=charts.comfortColor(15,20,25),hot=charts.comfortColor(30,20,25);assert.ok(cold[2]>cold[0]);assert.ok(hot[0]>hot[2]);
  const weak=charts.flowColor(2),strong=charts.flowColor(40);assert.ok(strong[0]>weak[0]);
});
test('actual analysis chart: hovering picks an hour and the 3D thermal layer follows; leaving returns to the mean',async()=>{
  const h=await createAppHarness();h.click('#analysis-btn');h.click('[data-layer="thermal"]');
  const chart=h.find('#analysis-chart');chart.getBoundingClientRect=()=>({left:0,top:0,width:640,height:220,right:640,bottom:220});
  h.dispatch(chart,'pointermove',{clientX:34+(640-34-92)*(15.5/24),clientY:100});
  assert.match(h.find('#analysis-readout').textContent,/^15:00/);assert.match(h.find('#legend-label').textContent,/15:00/);
  h.click('[data-chart-floor="2"]');assert.equal(h.find('[data-chart-floor="2"]').getAttribute('aria-pressed'),'true');
  h.dispatch(chart,'pointerleave');assert.match(h.find('#legend-label').textContent,/daily mean/i);
});

test('open-hand walk: starts after a steady open hand, survives short dropouts, stops when the hand closes',async()=>{
  const { createOpenHandWalk } = await import('../src/locomotion.js');
  const w=createOpenHandWalk({startMs:400,graceMs:300});
  assert.equal(w.update(true,0),false);assert.equal(w.update(true,300),false);assert.equal(w.update(true,420),true);
  // A misread frame every so often (as on a phone) keeps walking.
  for(let t=450;t<2000;t+=50)assert.equal(w.update(t%250!==0,t),true,'at '+t);
  // Hand closed or gone for longer than the grace: stop, and the wait starts again.
  assert.equal(w.update(false,2100),true);assert.equal(w.update(false,2400),false);
  for(let t=2500;t<2900;t+=50)assert.equal(w.update(true,t),false);assert.equal(w.update(true,2900),true);
  w.reset();assert.equal(w.walking,false);assert.equal(w.update(true,3000),false);
});
test('walking hand: needs the trained model to say open palm AND four fingers out; stops within 150 ms of closing',async()=>{
  const { isWalkingHand, createOpenHandWalk } = await import('../src/locomotion.js');
  const hand=curl=>Array.from({length:21},(_,i)=>{const finger=Math.floor((i-1)/4),joint=(i-1)%4;if(i===0)return{x:.5,y:.8};
    const x=.5+(finger-1.5)*.04,base=.68,len=joint*.05*(finger===0?.6:1);return{x,y:finger===0?base+.02:base-len*(joint===3&&curl?-1:1)};});
  const open=hand(0),closed=hand(1);
  assert.equal(isWalkingHand(open,{label:'open_palm',confidence:.9}),true);
  // A relaxed hand with straight fingers that the model does not call an open palm: no walking (the old rule walked).
  assert.equal(isWalkingHand(open,{label:'other',confidence:.8}),false);assert.equal(isWalkingHand(open,{label:'ok',confidence:.9}),false);
  assert.equal(isWalkingHand(open,{label:'open_palm',confidence:.65}),false,'unsure');assert.equal(isWalkingHand(open,null),false,'model not loaded');
  assert.equal(isWalkingHand(closed,{label:'open_palm',confidence:.95}),false,'fingers curled');
  const w=createOpenHandWalk();for(let t=0;t<=600;t+=60)w.update(true,t);assert.equal(w.walking,true);
  assert.equal(w.update(false,660),true);assert.equal(w.update(false,720),true);assert.equal(w.update(false,780),false,'stopped within 150 ms of the last open frame');
});
test('clap sensitivity slider in the hand dev view: saved, applied to the running listener, microphone test outside VR',async()=>{
  const storage=new Map([['aeroform-clap-sensitivity','0.3'],['aeroform-vr-guide','0']]);const h=await createAppHarness({storage});
  assert.equal(h.find('#clap-sensitivity').value,'30');assert.equal(h.find('#clap-sensitivity-value').textContent,'30');assert.equal(h.win.aeroform.inspect().clapSensitivity,.3);
  h.find('#clap-sensitivity').value='70';h.dispatch(h.find('#clap-sensitivity'),'input');
  assert.equal(storage.get('aeroform-clap-sensitivity'),'0.7');assert.equal(h.find('#clap-sensitivity-value').textContent,'70');assert.equal(h.win.aeroform.inspect().clapSensitivity,.7);
  // Microphone test outside VR: starts and stops the listener (no microphone in the harness: it reports why).
  h.click('#hand-dev-open');h.click('#hd-clap-test');assert.equal(h.win.aeroform.inspect().clap,'error');assert.equal(h.win.aeroform.inspect().state.vr,false);
  h.click('#hd-clap-test');assert.equal(h.win.aeroform.inspect().clap,'off');
  const fresh=await createAppHarness();assert.equal(fresh.find('#clap-sensitivity').value,'45','default');
});
test('renderer: VR floor change keeps the spot and stops at the top and bottom floors',()=>{
  const h=rendererHarness();h.viewer.update({view:'interior',floor:'all',layer:'architecture',vr:true},'vr');h.step();
  const start=h.viewer.inspect().vrPosition;assert.equal(h.viewer.changeFloor(-1),null);
  assert.equal(h.viewer.changeFloor(1),2);const up=h.viewer.inspect().vrPosition;near(up[1],1.65+3.45);near(up[0],start[0]);near(up[2],start[2]);
  assert.equal(h.viewer.changeFloor(1),null);assert.equal(h.viewer.changeFloor(-1),1);near(h.viewer.inspect().vrPosition[1],1.65);
  h.viewer.update({view:'interior',floor:'all',layer:'architecture',vr:false},'vr');assert.equal(h.viewer.changeFloor(1),null);
});

const fakeHand=gap=>Array.from({length:21},(_,i)=>i===0?{x:.5,y:.8,z:0}:i===9?{x:.5,y:.6,z:0}:i===4?{x:.5,y:.5,z:0}:i===8?{x:.5+gap,y:.5,z:0}:{x:.5,y:.6,z:0});
const flush=()=>new Promise(r=>setTimeout(r,0));
test('hand tracker: our own detector, camera lifecycle, one selection per pinch, one frame in flight, denial and insecure pages',async()=>{
  let frames=[],stopped=0,queue=[],time=0,result={landmarks:[]},calls=0,created=0;
  const video={readyState:4,currentTime:0,videoWidth:640,videoHeight:480,play:async()=>{}};
  const statuses=[];let pinches=0,ends=0;
  const tracker=createHandTracker({video,createDetector:async()=>{created++;return{name:'test detector',detect:async()=>{calls++;return {...result,presence:result.landmarks.length?.9:.1,ms:12};},close(){}};},
    getUserMedia:async()=>({getTracks:()=>[{stop:()=>stopped++}]}),schedule:fn=>{queue.push(fn);return queue.length;},cancel:()=>{queue=[];},now:()=>time,
    onStatus:s=>statuses.push(s.state),onFrame:f=>frames.push(f),onPinch:()=>pinches++,onPinchEnd:()=>ends++});
  const tick=async gap=>{result={landmarks:gap===null?[]:[fakeHand(gap)]};time+=40;video.currentTime+=.04;const run=queue;queue=[];run.forEach(fn=>fn());await flush();await flush();};
  assert.equal(await tracker.start(),true);assert.equal(created,1);assert.deepEqual(statuses,['starting','starting','tracking']);
  for(const gap of [.5,.04,.04,.04,.04,.5,.04,.04,null])await tick(gap);
  assert.equal(pinches,2);assert.equal(frames.at(-1).hand,null);assert.equal(tracker.running,true);
  const d=tracker.diagnostics();assert.equal(d.model,'test detector');assert.equal(d.frames,9);assert.equal(d.detectMs>0,true);assert.equal(d.presence,.1);
  // While a detection is still running, no second frame is sent.
  tracker.stop();assert.equal(stopped,1);assert.equal(tracker.running,false);assert.equal(statuses.at(-1),'off');assert.equal(video.srcObject,null);
  let release,slowCalls=0;const slow=createHandTracker({video,createDetector:async()=>({name:'slow',detect:()=>{slowCalls++;return new Promise(r=>{release=r;});}}),getUserMedia:async()=>({getTracks:()=>[{stop(){}}]}),schedule:fn=>{queue.push(fn);return 1;},cancel:()=>{queue=[];},now:()=>time});
  await slow.start();const before=slowCalls;for(let i=0;i<5;i++){time+=50;video.currentTime+=.05;const run=queue;queue=[];run.forEach(fn=>fn());await flush();}
  assert.equal(slowCalls-before,1);release({landmarks:[]});await flush();slow.stop();
  const failing=createHandTracker({video,createDetector:async()=>({detect:async()=>{throw new Error('boom');}}),getUserMedia:async()=>({getTracks:()=>[{stop(){}}]}),schedule:fn=>{queue.push(fn);return 1;},cancel:()=>{queue=[];},now:()=>time,onStatus:s=>statuses.push(s)});
  await failing.start();time+=50;video.currentTime+=.05;{const run=queue;queue=[];run.forEach(fn=>fn());}await flush();await flush();assert.match(statuses.at(-1).message,/stopped: boom/);
  const denied=[];const blocked=createHandTracker({video:{play:async()=>{}},getUserMedia:async()=>{throw Object.assign(new Error('no'),{name:'NotAllowedError'});},onStatus:s=>denied.push(s)});
  assert.equal(await blocked.start(),false);assert.match(denied.at(-1).message,/denied/);
  const constraints=[];const cam=createHandTracker({video,facingMode:'user',createDetector:async()=>({name:'x',detect:async()=>({landmarks:[]})}),schedule:()=>1,cancel:()=>{},now:()=>time,
    getUserMedia:async c=>{constraints.push(c.video.facingMode.ideal);return{getTracks:()=>[{stop(){}}],getVideoTracks:()=>[{label:'Front camera',getSettings:()=>({facingMode:'user'})}]};}});
  await cam.start();assert.equal(cam.diagnostics().cameraLabel,'Front camera');await cam.setOptions({facingMode:'environment'});assert.deepEqual(constraints,['user','environment']);assert.deepEqual(cam.options,{facingMode:'environment'});cam.stop();
  const saved=globalThis.window;globalThis.window={isSecureContext:false};const insecure=[];
  assert.equal(await createHandTracker({video:{},onStatus:s=>insecure.push(s)}).start(),false);assert.match(insecure.at(-1).message,/HTTPS/);globalThis.window=saved;
});
test('hand detector: searching letterboxes the frame, tracking crops around the hand, losing it searches again',async()=>{
  const { cropForFrame, roiFromLandmarks, toVideoPixels, createLandmarkSmoother, createHandNetDetector } = await import('../src/hand-detector.js');
  assert.deepEqual(cropForFrame(null,640,480),{cx:320,cy:240,side:640});
  const pts=Array.from({length:21},(_,i)=>({x:300+(i%5)*10,y:200+Math.floor(i/5)*10}));
  const roi=roiFromLandmarks(pts,640,480);near(roi.cx,320);near(roi.cy,220);near(roi.side,Math.max(96,40*1.8));
  const back=toVideoPixels([{x:.5,y:.5},{x:0,y:1}],{cx:320,cy:240,side:200});assert.deepEqual(back,[{x:320,y:240},{x:220,y:340}]);
  const sm=createLandmarkSmoother(.5);sm.update([{x:0,y:0}]);assert.deepEqual(sm.update([{x:1,y:1}]),[{x:.5,y:.5,z:0}]);
  // A fake worker and canvas: presence high once, then low.
  const drawn=[];let reply=null;const worker={postMessage(m){if(m.type==='load')setTimeout(()=>this.onmessage({data:{type:'ready',input:128}}));else setTimeout(()=>this.onmessage({data:{type:'result',id:m.id,...reply}}));},terminate(){}};
  const canvas={getContext:()=>({fillRect(){},drawImage:(...a)=>drawn.push(a),getImageData:()=>({data:new Uint8ClampedArray(128*128*4)}),fillStyle:''})};
  const det=await createHandNetDetector({createWorker:()=>worker,createCanvas:()=>canvas});
  const video={videoWidth:640,videoHeight:480};
  reply={presence:.9,ms:5,keypoints:Array.from({length:21},(_,i)=>({x:.4+(i%5)*.05,y:.4+Math.floor(i/5)*.05}))};
  const first=await det.detect(video);assert.equal(first.mode,'searching');assert.equal(first.landmarks.length,1);assert.equal(det.tracking,true);
  assert.deepEqual(drawn[0].slice(5),[0,16,128,96]);
  const second=await det.detect(video);assert.equal(second.mode,'tracking');
  reply={presence:.1,ms:5,keypoints:[]};const lost=await det.detect(video);assert.deepEqual(lost.landmarks,[]);assert.equal(det.tracking,false);
});

test('demo 3D models: checked-in files match the generator, parse, and are the same list the app offers',async()=>{
  const { buildDemoModels, DEMO_MODELS } = await import('../scripts/demo-models.mjs');const { parseModel } = await import('../src/mesh.js');
  const root=new URL('../',import.meta.url),app=await readFile(new URL('app.js',root),'utf8');
  for(const model of buildDemoModels()){
    const file=await readFile(new URL(model.file,root));assert.ok(file.equals(model.bytes),model.file+' is out of date: run node scripts/demo-models.mjs');
    const mesh=parseModel(model.file,file);assert.equal(mesh.triangles,model.triangles);assert.ok(mesh.triangles>=200,model.file);
    assert.ok(Math.abs(Math.max(...mesh.size)-8)<1e-6&&Math.min(...mesh.size)>3,model.file+' fitted, not flat');
    // Upright: models are taller than a slab, and the STL Z-up conversion did not lay them on their side.
    assert.ok(mesh.size[1]>3,model.file+' height '+mesh.size[1]);
    // Outward faces: most faces of a solid built from closed parts face away from the model's vertical axis or up/down.
    let out=0;const v=mesh.vertices,cx=0,cz=0;
    for(let t=0;t<mesh.triangles;t++){const o=t*18,c=[0,1,2].map(k=>(v[o+k]+v[o+6+k]+v[o+12+k])/3),n=[v[o+3],v[o+4],v[o+5]];
      if(Math.abs(n[1])>.9||n[0]*(c[0]-cx)+n[2]*(c[2]-cz)>=0)out++;}
    assert.ok(out/mesh.triangles>.6,model.file+' faces outward: '+(out/mesh.triangles).toFixed(2));
    assert.ok(app.includes(`file:'${model.file}',label:'${model.label}'`),model.file+' listed in app.js');
    for(const list of ['scripts/server.mjs','sw.js','scripts/verify-apk.ps1'])assert.ok((await readFile(new URL(list,root),'utf8')).includes(model.file),list+' misses '+model.file);
  }
  assert.equal(DEMO_MODELS.length,4);
  // In the app: the menu lists them; opening one loads it in 3D, and Show demo house returns.
  const h=await createAppHarness({fetch:async url=>{const bytes=await readFile(new URL(url,root));return{ok:true,status:200,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};}});
  const buttons=h.find('#demo-models').querySelectorAll('[data-demo-model]');assert.equal(buttons.length,4);assert.ok(buttons.every(b=>!b.disabled));
  buttons[2].click();for(let i=0;i<5;i++)await h.settle();
  assert.equal(h.win.aeroform.inspect().cloudModel,'Geodesic dome');assert.match(h.find('#demo-models-status').textContent,/Geodesic dome open · 254 triangles/);
  assert.equal(h.find('#legend-label').textContent,'Geodesic dome');assert.equal(h.find('#project-label'),null,'no project name line');
  h.click('#demo-btn');assert.equal(h.win.aeroform.inspect().cloudModel,null);
});
test('hand model worker: detection runs off the main thread; frames are handed over; a failing worker is reported',async()=>{
  const { createMediaPipeWorkerDetector, MEDIAPIPE_WORKER_URL } = await import('../src/mediapipe-detector.js');
  assert.match(MEDIAPIPE_WORKER_URL,/src\/mediapipe-worker\.js$/);
  const made=[];
  class FakeWorker{constructor(url,options){this.url=url;this.options=options;this.sent=[];this.terminated=false;made.push(this);}
    postMessage(data,transfer){this.sent.push({data,transfer});queueMicrotask(()=>{
      if(data.type==='init')this.onmessage({data:this.fail?{type:'error',message:'no GL'}:{type:'log',message:'GPU ok'}});
      if(data.type==='init'&&!this.fail)this.onmessage({data:{type:'ready',name:'MediaPipe test',delegate:'GPU'}});
      if(data.type==='detect')this.onmessage({data:{type:'result',id:data.id,landmarks:[[{x:.5,y:.5,z:0}]],presence:.9,ms:12,mode:'tracking'}});});}
    terminate(){this.terminated=true;}}
  const logs=[],bitmap={close(){}};
  const d=await createMediaPipeWorkerDetector({WorkerClass:FakeWorker,createBitmap:async()=>bitmap,log:m=>logs.push(m)});
  assert.equal(made[0].options.type,'module');assert.match(d.name,/background thread/);assert.equal(d.delegate,'GPU');assert.deepEqual(logs,['GPU ok']);
  const r=await d.detect({},100);assert.equal(r.landmarks[0][0].x,.5);assert.equal(r.presence,.9);
  const job=made[0].sent.find(m=>m.data.type==='detect');assert.equal(job.data.frame,bitmap);assert.deepEqual(job.transfer,[bitmap]);assert.equal(job.data.time,100);
  d.close();assert.equal(made[0].terminated,true);await assert.rejects(d.detect({},200),/closed/);
  class Failing extends FakeWorker{constructor(...a){super(...a);this.fail=true;}}
  await assert.rejects(createMediaPipeWorkerDetector({WorkerClass:Failing}),/no GL/);assert.equal(made.at(-1).terminated,true);
  await assert.rejects(createMediaPipeWorkerDetector({WorkerClass:undefined}),/not available/);
  // A worker that never answers is given up after the timeout.
  class Silent extends FakeWorker{postMessage(){}}
  let fire;await assert.rejects(Promise.all([createMediaPipeWorkerDetector({WorkerClass:Silent,setTimer:fn=>{fire=fn;return 1;},clearTimer(){}}),Promise.resolve().then(()=>fire())]),/did not start/);
});
test('hand landmarks: vendored MediaPipe matches its documented hashes, is cached and packaged, and is labelled as third party',async()=>{
  const root=new URL('../',import.meta.url);const { createHash } = await import('node:crypto');
  const readme=await readFile(new URL('vendor/mediapipe/README.md',root),'utf8');
  for(const f of ['vision_bundle.mjs','wasm/vision_wasm_internal.js','wasm/vision_wasm_internal.wasm','hand_landmarker.task']){
    const hash=createHash('sha256').update(await readFile(new URL('vendor/mediapipe/'+f,root))).digest('hex');
    assert.ok(readme.includes(hash),f+' hash not documented');
    for(const list of ['scripts/server.mjs','sw.js','scripts/verify-apk.ps1'])assert.ok((await readFile(new URL(list,root),'utf8')).includes('vendor/mediapipe/'+f),list+' misses '+f);
  }
  assert.match(await readFile(new URL('vendor/mediapipe/LICENSE',root),'utf8'),/Apache License\s+Version 2\.0/);
  // HandNet stays an experiment: not loaded by the app, not shipped.
  for(const f of ['scripts/server.mjs','sw.js','scripts/build-apk.ps1','scripts/verify-apk.ps1','src/hand-tracking.js','app.js'])assert.doesNotMatch(await readFile(new URL(f,root),'utf8'),/handnet\.json|handnet-worker|createHandNetDetector/,f);
  const { AI_COMPONENTS } = await import('../src/ai/registry.js');
  const mp=AI_COMPONENTS.find(c=>c.id==='hand-landmarks');assert.match(mp.kind,/not trained here/);assert.equal(mp.status,'active');
  assert.match(AI_COMPONENTS.find(c=>c.id==='handnet').status,/not used/);
  const { MEDIAPIPE_ASSETS, createMediaPipeDetector } = await import('../src/mediapipe-detector.js');
  assert.ok(Object.values(MEDIAPIPE_ASSETS).every(u=>u.includes('/vendor/mediapipe/')));
  // GPU failure falls back to CPU; detections come back in the tracker's shape.
  const made=[];const vision={HandLandmarker:{createFromOptions:async(_,o)=>{made.push(o.baseOptions.delegate);if(o.baseOptions.delegate==='GPU')throw new Error('no GL');
    return{detectForVideo:(v,t)=>({landmarks:t>5?[[{x:.5,y:.5,z:0}]]:[],handedness:[[{score:.93}]]}),close(){}};}}};
  const logs=[];const d=await createMediaPipeDetector({loadVision:async()=>vision,log:m=>logs.push(m)});
  assert.deepEqual(made,['GPU','CPU']);assert.equal(d.delegate,'CPU');assert.match(logs[0],/GPU hand model failed/);
  assert.deepEqual(d.detect({},1).landmarks,[]);const hit=d.detect({},10);assert.equal(hit.landmarks.length,1);assert.equal(hit.presence,.93);assert.equal(hit.mode,'tracking');
});
test('HandNet: our plain-JS inference reproduces the trained PyTorch model on the reference input',async()=>{
  const { createHandNet } = await import('../src/handnet.js');
  const model=JSON.parse(await readFile(new URL('../models/handnet.json',import.meta.url),'utf8'));
  assert.equal(model.format,'aeroform-handnet-v1');assert.match(model.training.init,/random/);
  const net=createHandNet(model),out=net.forward(net.checkInput());
  out.keypoints.forEach((k,i)=>{near(k.x,model.check.keypoints[i][0],2e-4);near(k.y,model.check.keypoints[i][1],2e-4);});
  near(out.presenceLogit,model.check.presence,2e-3);
  const blank=net.detectPixels(new Uint8ClampedArray(128*128*4));assert.equal(blank.keypoints.length,21);assert.ok(blank.presence>=0&&blank.presence<=1);
});

test('EnergyPlus export: same zones, windows and doors as the simplified model; paired interzone surfaces; capacity per AC',async()=>{
  const { buildIdf, parseEnergyPlusCsv } = await import('../src/simulation/energyplus.js');
  const { normalizeDesign } = await import('../src/simulation/index.js');
  const { applySeason } = await import('../src/conditions.js');
  const built=buildIdf({building,design:normalizeDesign(),conditions:applySeason('winter')});
  const objects=built.idf.split(/;\s*\n/).map(o=>o.split(/,\s*\n\s*/).map(f=>f.trim()));
  const of=type=>objects.filter(o=>o[0]===type);
  assert.equal(of('Version')[0][1],'26.2');
  assert.deepEqual(of('Zone').map(z=>z[1]),['living-1','bedroom-1','hall-1','living-2','bedroom-2','hall-2']);
  const fen=of('FenestrationSurface:Detailed');
  assert.equal(fen.filter(f=>f[2]==='Window').length,14);assert.equal(fen.filter(f=>f[2]==='Door').length,4);
  // Window area matches the simplified model's window surfaces (sub-surfaces are inset 1 cm at wall edges).
  const area=v=>{const p=[0,1,2,3].map(k=>v.slice(k*3,k*3+3).map(Number));const a=p[1].map((x,i)=>x-p[0][i]),b=p[2].map((x,i)=>x-p[1][i]);return Math.hypot(a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]);};
  const epWindows=fen.filter(f=>f[2]==='Window').reduce((s,f)=>s+area(f.slice(10,22)),0);
  const simWindows=built.model.zones.flatMap(z=>z.surfaces).filter(s=>s.type==='window').reduce((s,w)=>s+w.area,0);
  assert.ok(Math.abs(epWindows-simWindows)/simWindows<0.02,`${epWindows} vs ${simWindows}`);
  // Every interzone surface points at a surface that points back.
  const surfaces=of('BuildingSurface:Detailed'),byName=new Map(surfaces.map(s=>[s[1],s]));
  const inter=surfaces.filter(s=>s[6]==='Surface');assert.ok(inter.length>=16);
  for(const s of inter)assert.equal(byName.get(s[7])?.[7],s[1],s[1]);
  assert.equal(surfaces.filter(s=>s[6]==='Ground').length,4);assert.equal(surfaces.filter(s=>s[2]==='Roof').length,4);
  // Doorways and stair exchange air both ways; ACs (both in the halls by default) set the capacity.
  assert.equal(of('ZoneCrossMixing').length,10);
  const ideal=of('HVACTemplate:Zone:IdealLoadsAirSystem');
  assert.deepEqual(ideal.map(i=>Number(i[10])),[0,3500,0,0,3500,0]);assert.deepEqual(ideal.map(i=>Number(i[13])),[0,3500,0,0,3500,0]);
  assert.ok(ideal.every(i=>i[21]==='Flow/Zone'&&Number(i[24])>0));
  // CSV reader: 480 time steps of constant 20 °C and 1 kW heating in one zone gives 24 kWh.
  const cols=built.zones.flatMap(z=>[`${z.toUpperCase()}:Zone Mean Air Temperature [C](TimeStep)`,`${z.toUpperCase()} IDEAL LOADS AIR SYSTEM:Zone Ideal Loads Supply Air Sensible Heating Rate [W](TimeStep)`,`${z.toUpperCase()} IDEAL LOADS AIR SYSTEM:Zone Ideal Loads Supply Air Sensible Cooling Rate [W](TimeStep)`]);
  const rows=Array.from({length:480},()=>['01/15 00:03:00',...built.zones.flatMap((z,i)=>[20,i===2?1000:0,0])].join(','));
  const r=parseEnergyPlusCsv(['Date/Time,'+cols.join(','),...rows].join('\n'),built);
  near(r.totals.heatingKWh,24,1e-9);near(r.totals.peakHeatingKW,1,1e-9);near(r.zones[0].meanC,20,1e-9);assert.equal(r.zones[0].hourlyC.length,24);
  assert.equal(r.model.name,'EnergyPlus');
});

test('surrogate features: physical values, season from temperature, and HVAC counts that follow moved units',async()=>{
  const { surrogateFeatures, FEATURE_NAMES, TARGET_NAMES, surrogateTargets } = await import('../src/simulation/surrogate-features.js');
  const { analyze, normalizeDesign } = await import('../src/simulation/index.js');
  const { acPlacement, buildThermalModel } = await import('../src/simulation/model.js');
  const conditions={season:'custom',temperature:30,wind:'E',windSpeed:2},design=normalizeDesign();
  const f=surrogateFeatures({building,design,conditions});const at=name=>f[FEATURE_NAMES.indexOf(name)];
  assert.equal(f.length,FEATURE_NAMES.length);assert.equal(at('window_u'),2.8);assert.equal(at('season_summer'),1);assert.equal(at('wind_E'),1);
  assert.equal(at('ac_bedroom-1'),1);assert.equal(at('ac_hall-1'),0);
  const home=building.boxes.find(b=>b.group==='ac-1'&&b.type).home,target=acPlacement(buildThermalModel(building,design),'hall-1');
  const moved=surrogateFeatures({building,design,conditions,moves:{'ac-1':target.map((v,k)=>v-home[k])}});
  assert.equal(moved[FEATURE_NAMES.indexOf('ac_hall-1')],1);assert.equal(moved[FEATURE_NAMES.indexOf('ac_bedroom-1')],0);
  assert.equal(surrogateTargets(analyze({building,design,conditions}).result).length,TARGET_NAMES.length);
  assert.equal(surrogateFeatures({building:{...building,thermal:{...building.thermal,zones:building.thermal.zones.slice(0,2)}},design,conditions}),null);
});

for(const engine of ['simple','energyplus'])test(`energy surrogate (${engine}): JS inference reproduces the Python export and meets its accuracy bar`,async t=>{
  let model;try{model=JSON.parse(await readFile(new URL(`../models/energy-surrogate-${engine}.json`,import.meta.url),'utf8'));}catch{if(engine==='simple')return t.skip('not trained');throw new Error('models/energy-surrogate-energyplus.json is missing; run training/train_surrogate.py energyplus');}
  const { createEnergySurrogate } = await import('../src/energy-surrogate.js');
  const s=createEnergySurrogate(model);
  model.check.inputs.forEach((x,k)=>s.forward(x).forEach((v,i)=>assert.ok(Math.abs(v-model.check.outputs[k][i])<=2e-3*Math.max(1,Math.abs(v)),`output ${i}: ${v} vs ${model.check.outputs[k][i]}`)));
  const m=model.metrics[`surrogate_vs_${engine}`];
  assert.ok(m.room_temperature_hourly_c.mae<1.0,`hourly room temperature error ${m.room_temperature_hourly_c.mae} °C`);
  assert.ok(m.heating_kwh.r2>0.95&&m.cooling_kwh.r2>0.95);
  const { normalizeDesign } = await import('../src/simulation/index.js');
  const p=s.predict({building,design:normalizeDesign(),conditions:{season:'winter',temperature:-5,wind:'N',windSpeed:6}});
  assert.equal(p.zones.length,6);assert.ok(p.inRange);assert.ok(p.totals.heatingKWh>p.totals.coolingKWh);
  assert.ok(p.zones.every(z=>z.minC<=z.meanC&&z.meanC<=z.maxC));
});

test('clap detector: a clap fires once; the sensitivity setting decides how faint; speech, music and noise never fire',async()=>{
  const { createClapDetector, clapThresholds, CLAP_STRICT, CLAP_EAGER, DEFAULT_CLAP_SENSITIVITY } = await import('../src/clap-detector.js');
  const rate=48000,block=1024,ms=block/rate*1000;
  let seed=1;const noise=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2147483648-1;};
  // Feed a signal(tSeconds) through the detector in 1024-sample blocks; returns the times it fired.
  const run=(signal,sensitivity=DEFAULT_CLAP_SENSITIVITY,seconds=2)=>{const d=createClapDetector({sensitivity}),fired=[];for(let b=0;b*ms<seconds*1000;b++){const s=new Float32Array(block);for(let i=0;i<block;i++)s[i]=signal((b*block+i)/rate);if(d.update(s,b*ms))fired.push(b*ms);}return fired;};
  const room=()=>0.003*noise();
  const clap=(t,at,amp=0.8,tau=0.012)=>t>=at?amp*noise()*Math.exp(-(t-at)/tau):0; // sharp burst, ~12 ms decay
  assert.equal(run(t=>room()+clap(t,1.0)).length,1,'one clap');
  // Sensitivity 0-1 moves every threshold between strict and eager; the default needs a clap at about 0.2.
  assert.deepEqual(clapThresholds(0),{...CLAP_STRICT});assert.deepEqual(clapThresholds(1),{...CLAP_EAGER});assert.deepEqual(clapThresholds(5),{...CLAP_EAGER});
  assert.ok(clapThresholds(.3).minPeak>clapThresholds(.6).minPeak&&clapThresholds(.3).overBackground>clapThresholds(.6).overBackground);
  const faintest=s=>[0.05,0.08,0.12,0.2,0.3,0.5,0.8].find(amp=>run(t=>room()+clap(t,1.0,amp),s).length===1);
  assert.equal(faintest(0),0.5);assert.equal(faintest(DEFAULT_CLAP_SENSITIVITY),0.2);assert.ok(faintest(1)<=0.08);
  for(const s of [0,.2,.4,.6,.8])assert.ok(faintest(s)>=faintest(s+.2),'more sensitive never hears less');
  // At the default, a soft click or tap does not count; at full sensitivity it may.
  assert.equal(run(t=>room()+clap(t,1.0,0.15,0.003)).length,0,'tap');assert.equal(run(t=>room()+clap(t,1.0,0.1,0.004)).length,0,'soft click');
  // Changing the setting applies at once.
  const live=createClapDetector({sensitivity:0});assert.equal(live.sensitivity,0);live.setSensitivity(1);assert.equal(live.sensitivity,1);assert.ok(Math.abs(live.threshold-.05)<1e-9);
  // A clap that starts near the end of a block still counts; so does one with room echo.
  for(const at of [1.005,1.012,1.018])assert.equal(run(t=>room()+clap(t,at,0.25)).length,1,'clap across blocks at '+at);
  assert.equal(run(t=>room()+clap(t,1.0,0.3,0.04)).length,1,'clap with echo');
  assert.equal(run(t=>room()+clap(t,0.5)+clap(t,1.5)).length,2,'two separate claps');
  assert.equal(run(t=>room()+clap(t,1.0,0.35)).length,1,'a softer clap');
  assert.equal(run(t=>room()+clap(t,1.0)+clap(t,1.15)).length,1,'a quick double clap counts once');
  // Never a clap, even at full sensitivity. Voice-like: 180 Hz tone with syllable envelope, loud, 300 ms at a time.
  assert.equal(run(t=>room()+(t%0.6<0.3?0.5*Math.sin(2*Math.PI*180*t)*Math.sin(Math.PI*(t%0.6)/0.3):0),1).length,0,'speech');
  assert.equal(run(t=>room()+0.4*Math.sin(2*Math.PI*440*t)+0.2*Math.sin(2*Math.PI*660*t),1).length,0,'music tone');
  assert.equal(run(t=>0.3*noise(),1).length,0,'steady loud noise (fan, traffic)');
  assert.equal(run(t=>room()+Math.min(1,t/1.5)*0.6*noise(),1).length,0,'noise swelling up');
  // A spoken "t" followed by its vowel, and a cough-length burst, keep sounding too long for a clap.
  const syllable=(t,at)=>{const u=t-at;return u<0||u>0.25?0:(u<0.015?0.5*noise():0)+0.4*Math.sin(2*Math.PI*160*t)*Math.min(1,u/0.03);};
  assert.equal(run(t=>room()+syllable(t,0.5)+syllable(t,1.2),1).length,0,'consonant + vowel');
  assert.equal(run(t=>room()+(t>1&&t<1.12?0.4*noise():0),1).length,0,'cough-length burst');
  // A clap over loud steady noise is still heard when it clearly stands out.
  assert.equal(run(t=>0.03*noise()+clap(t,1.0,0.9)).length,1,'clap over background noise');
});

test('clap listener: raw microphone, a clap calls onClap once, stop releases the microphone; refusal is reported',async()=>{
  const { startClapListener, createClapDetector } = await import('../src/clap-detector.js');
  let seed=3;const noise=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/2147483648-1;};
  let t=0,tick=null,stopped=0,closed=0,constraints=null;
  const clapAt=1000,sample=time=>.003*noise()+(time>=clapAt?.8*noise()*Math.exp(-(time-clapAt)/12):0);
  const analyser={fftSize:0,getFloatTimeDomainData(block){const ms=21.3;for(let i=0;i<block.length;i++)block[i]=sample(t-ms+ms*i/block.length);}};
  class FakeAudioContext{createAnalyser(){return analyser;}createMediaStreamSource(){return{connect(){}};}resume(){}close(){closed++;}}
  const media={getUserMedia:async c=>{constraints=c;return{getTracks:()=>[{stop:()=>stopped++}]};}};
  let claps=0;
  const listener=startClapListener({onClap:()=>claps++,media,AudioContextClass:FakeAudioContext,now:()=>t,setTimer:fn=>{tick=fn;return 1;},clearTimer:()=>{tick=null;},detector:createClapDetector()});
  await new Promise(r=>setTimeout(r,0));
  assert.deepEqual(constraints,{audio:{echoCancellation:false,noiseSuppression:false,autoGainControl:false}});
  assert.equal(listener.diagnostics().state,'listening');
  for(t=0;t<2000;t+=21.3)tick();
  assert.equal(claps,1);
  listener.stop();assert.equal(stopped,1);assert.equal(closed,1);assert.equal(tick,null);assert.equal(listener.diagnostics().state,'off');
  // Where the browser offers it, every sample is read in back-to-back blocks timed by the audio clock.
  let processor=null,procClaps=0,procStopped=0;
  class ProcessorContext{constructor(){this.sampleRate=48000;this.destination={};}createScriptProcessor(size){processor={size,connect(){},disconnect(){this.disconnected=true;}};return processor;}createAnalyser(){throw new Error('not used');}createMediaStreamSource(){return{connect(){}};}resume(){}close(){}}
  const live=startClapListener({onClap:()=>procClaps++,media:{getUserMedia:async()=>({getTracks:()=>[{stop:()=>procStopped++}]})},AudioContextClass:ProcessorContext,now:()=>0,setTimer:()=>{throw new Error('no timer needed');},detector:createClapDetector()});
  await new Promise(r=>setTimeout(r,0));assert.equal(processor.size,1024);
  for(let b=0;b<94;b++){const data=new Float32Array(1024);for(let i=0;i<1024;i++)data[i]=sample((b*1024+i)/48);processor.onaudioprocess({inputBuffer:{sampleRate:48000,getChannelData:()=>data}});}
  assert.equal(procClaps,1);const dx=live.diagnostics();assert.ok(dx.threshold>0&&dx.peak>=0);
  live.stop();assert.equal(processor.onaudioprocess,null);assert.equal(processor.disconnected,true);assert.equal(procStopped,1);
  let error='';
  const refused=startClapListener({onClap(){},onError:m=>error=m,media:{getUserMedia:async()=>{const e=new Error('no');e.name='NotAllowedError';throw e;}},AudioContextClass:FakeAudioContext,setTimer:()=>1,clearTimer(){}});
  await new Promise(r=>setTimeout(r,0));assert.match(error,/Microphone not allowed/);assert.equal(refused.diagnostics().state,'error');
  let missing='';startClapListener({onClap(){},onError:m=>missing=m,media:undefined,AudioContextClass:FakeAudioContext});assert.match(missing,/microphone/);
});
