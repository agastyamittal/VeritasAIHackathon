import { createViewerState, validateDesign } from './src/viewer-state.js';
import { DEFAULT_OPTICS, normalizeOptics, calculateAutomaticFit, normalizeLensFit } from './src/vr-optics.js';
import { createCloud } from './src/cloud.js';
import { canRender, parseModel } from './src/mesh.js';
import { createHandTracker } from './src/hand-tracking.js';
import { loadGestureClassifier, createGestureCommands, createFistOpenToggle, GESTURE_LABELS } from './src/gesture-classifier.js';
import { createStepDetector, createOpenHandWalk, isWalkingHand, grabOffset, STEP_LENGTH_METRES, HAND_WALK_SPEED } from './src/locomotion.js';
import { startClapListener, createClapDetector, DEFAULT_CLAP_SENSITIVITY } from './src/clap-detector.js';
import { normalizeConditions, applySeason, editCondition, describeConditions } from './src/conditions.js';
import { createAnalysisPanel } from './src/analysis-panel.js';
import { loadEnergySurrogate } from './src/energy-surrogate.js';

const $ = selector => document.querySelector(selector);
const canvas = $('#viewport');
let viewer = null, generation = 0, vrSession = 0, hadFullscreen = false;
const cloud=createCloud({fetch:typeof window.fetch==='function'?window.fetch.bind(window):undefined});
let activeModel=null,cloudRequest=0,openRequest=0;
let analysisViz=null,analysisPanel=null;
const LAYER_TITLES=Object.freeze({architecture:'Architecture',airflow:'Airflow',thermal:'Thermal',heatloss:'Heat loss'});
const legendText=value=>activeModel?activeModel.label:value.layer!=='architecture'&&analysisViz?.[value.layer]?analysisViz[value.layer].legend:{architecture:'Atrium House · 2 floors',airflow:'Airflow · simulating…',thermal:'Room temperature · simulating…',heatloss:'Heat loss · simulating…'}[value.layer];
let lensFit=normalizeLensFit(),optics=calculateAutomaticFit().optics,calibrating=false;
try{
  const stored=window.localStorage.getItem('aeroform-lens-fit-v2');
  if(stored)lensFit=normalizeLensFit(JSON.parse(stored));
  else{
    const legacy=JSON.parse(window.localStorage.getItem('aeroform-lens-fit-v1'));
    if(legacy&&typeof legacy==='object')lensFit=normalizeLensFit({mode:'auto',manual:legacy});
  }
}catch{}
const state = createViewerState((value,key) => {
  viewer?.update(value,key);
  for (const attr of ['view','floor','layer']) document.querySelectorAll(`[data-${attr}]`).forEach(button=>{
    const active=button.dataset[attr]===value[attr];button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));
    const icon=button.querySelector('i');if(icon&&!button.disabled)icon.textContent=active?'✓':'+';
  });
  $('#layer-label').textContent=(value.view==='interior'?'':'Exterior · ')+(LAYER_TITLES[value.layer]??value.layer);
  $('#legend-label').textContent=legendText(value);
  $('#simulation-note').hidden=value.layer==='architecture';
  document.body.classList.toggle('stereo-mode',value.vr);
  $('#stereo-hud').hidden=!value.vr;
  $('#vr-btn').setAttribute('aria-pressed',String(value.vr));
});

function panel(open) {
  $('#sidebar').classList.toggle('open',open);$('#panel-backdrop').hidden=!open;
  $('#panel-btn').setAttribute('aria-expanded',String(open));
  if(open){$('#close-panel').focus();refreshCloud();}
}
$('#panel-btn').addEventListener('click',()=>panel(!$('#sidebar').classList.contains('open')));
$('#close-panel').addEventListener('click',()=>{panel(false);$('#panel-btn').focus();});
$('#panel-backdrop').addEventListener('click',()=>panel(false));
$('#help-btn').addEventListener('click',()=>$('#help-modal').showModal());
$('#menu-help-btn').addEventListener('click',()=>{panel(false);$('#help-modal').showModal();});

// Weather / sim conditions: stored inputs only (src/conditions.js); nothing here simulates them.
let conditions=normalizeConditions();
try{const stored=window.localStorage.getItem('aeroform-conditions-v1');if(stored)conditions=normalizeConditions(JSON.parse(stored));}catch{}
function syncConditions(save=false){
  const summary=describeConditions(conditions);
  $('#conditions-summary').textContent=summary;$('#conditions-pill-summary').textContent=summary.split(' · ').slice(0,2).join(' · ');
  document.querySelectorAll('[data-season]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.season===conditions.season)));
  document.querySelectorAll('[data-wind]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.wind===conditions.wind)));
  $('#cond-temperature').value=String(conditions.temperature);$('#cond-temperature-value').textContent=conditions.temperature+' °C';
  $('#cond-wind-speed').value=String(conditions.windSpeed);$('#cond-wind-speed-value').textContent=conditions.windSpeed+' m/s';
  if(save){try{window.localStorage.setItem('aeroform-conditions-v1',JSON.stringify(conditions));}catch{}analysisPanel?.run();}
}
function openConditions(){panel(false);$('#conditions-modal').showModal();}
$('#conditions-btn').addEventListener('click',openConditions);
$('#conditions-pill').addEventListener('click',openConditions);
$('#close-conditions').addEventListener('click',()=>$('#conditions-modal').close());
$('#conditions-done').addEventListener('click',()=>$('#conditions-modal').close());
$('#conditions-analysis').addEventListener('click',()=>{$('#conditions-modal').close();openAnalysis();});
document.querySelectorAll('[data-season]').forEach(b=>b.addEventListener('click',()=>{conditions=applySeason(b.dataset.season);syncConditions(true);}));
document.querySelectorAll('[data-wind]').forEach(b=>b.addEventListener('click',()=>{conditions=editCondition(conditions,'wind',b.dataset.wind);syncConditions(true);}));
$('#cond-temperature').addEventListener('input',e=>{conditions=editCondition(conditions,'temperature',Number(e.target.value));syncConditions(true);});
$('#cond-wind-speed').addEventListener('input',e=>{conditions=editCondition(conditions,'windSpeed',Number(e.target.value));syncConditions(true);});
syncConditions();
$('#close-help').addEventListener('click',()=>$('#help-modal').close());
$('#help-modal').addEventListener('click',event=>{if(event.target===$('#help-modal')){const b=event.target.getBoundingClientRect();if(event.clientX<b.left||event.clientX>b.right||event.clientY<b.top||event.clientY>b.bottom)event.target.close();}});
$('#upload-btn').addEventListener('click',()=>$('#design-upload').click());
$('#local-btn').addEventListener('click',()=>$('#local-upload').click());
function uploadStatus(title,description){$('#upload-title').textContent=title;$('#upload-description').textContent=description;}
function uploadError(message){$('#upload-error').hidden=!message;$('#upload-error').textContent=message||'';}
const formatSize=bytes=>!Number.isFinite(bytes)?'':bytes<1048576?Math.max(1,Math.round(bytes/1024))+' KB':(bytes/1048576).toFixed(1)+' MB';
// fileName decides the format (STL or OBJ); label is what the app shows.
function showModel(label,buffer,source='Cloud model',fileName=label){
  if(!viewer)throw new Error('The 3D viewer is not ready yet.');
  const mesh=parseModel(fileName,buffer);mesh.name=label;viewer.setModel(mesh);
  activeModel={label,triangles:mesh.triangles,source};$('#demo-btn').hidden=false;
  $('#legend-label').textContent=legendText(state.get());
  $('#scene-status').textContent=mesh.triangles.toLocaleString()+' triangles · fitted to 8 m';
}
function showDemo(){
  viewer?.setModel(null);activeModel=null;$('#demo-btn').hidden=true;
  $('#legend-label').textContent=legendText(state.get());
  if(viewer)$('#scene-status').textContent='';
}
// Demo 3D models shipped with the app (generated by scripts/demo-models.mjs; files in samples/).
const DEMO_MODELS=Object.freeze([
  {file:'samples/modern-cabin.obj',label:'Modern cabin',description:'Glass front, mono-pitch roof, deck'},
  {file:'samples/twisting-tower.stl',label:'Twisting tower',description:'14 floors, each turned 6°'},
  {file:'samples/geodesic-dome.obj',label:'Geodesic dome',description:'Pavilion with an entrance'},
  {file:'samples/spiral-stair.stl',label:'Spiral stair',description:'20 treads with a handrail'}
]);
let demoRequest=0;
async function openDemoModel(item){
  const request=++demoRequest;$('#demo-models-status').textContent='Opening '+item.label+'…';
  try{
    const response=await window.fetch(item.file);
    if(!response.ok)throw new Error(item.label+' could not be loaded ('+response.status+').');
    const buffer=await response.arrayBuffer();if(request!==demoRequest)return;
    showModel(item.label,buffer,'Demo model',item.file);$('#demo-models-status').textContent=item.label+' open · '+activeModel.triangles.toLocaleString()+' triangles';panel(false);
  }catch(error){if(request===demoRequest)$('#demo-models-status').textContent=error.message;}
}
$('#demo-models').replaceChildren(...DEMO_MODELS.map(item=>{
  const row=document.createElement('li'),button=document.createElement('button'),name=document.createElement('b'),meta=document.createElement('small');
  button.type='button';button.className='cloud-file';button.setAttribute('data-demo-model',item.file);button.setAttribute('data-scene','');button.disabled=!viewer;
  name.textContent=item.label;meta.textContent=item.description+' · '+item.file.split('.').pop().toUpperCase();
  button.append(name,meta);button.addEventListener('click',()=>openDemoModel(item));row.append(button);return row;
}));
async function refreshCloud(){
  if(!cloud.available){$('#cloud-status').textContent='Cloud is unavailable here.';return;}
  const request=++cloudRequest;$('#cloud-status').textContent='Checking cloud…';
  try{
    const files=await cloud.list();if(request!==cloudRequest)return;
    $('#cloud-list').replaceChildren(...files.map(item=>{
      const row=document.createElement('li'),button=document.createElement('button'),name=document.createElement('b'),meta=document.createElement('small');
      button.type='button';button.className='cloud-file';button.dataset.name=item.name;
      name.textContent=item.label;meta.textContent=[formatSize(item.size),canRender(item.name)?'3D':'stored only'].filter(Boolean).join(' · ');
      button.append(name,meta);button.addEventListener('click',()=>openCloudFile(item));row.append(button);return row;
    }));
    $('#cloud-status').textContent=files.length?files.length+(files.length===1?' file':' files')+' · newest first':'No files yet. Upload one from any device.';
  }catch(error){if(request===cloudRequest)$('#cloud-status').textContent=error.message;}
}
async function openCloudFile(item){
  const request=++openRequest;
  if(!canRender(item.name)){
    $('#cloud-status').textContent=item.label+' is stored. 3D preview supports STL and OBJ.';
    if(!window.AeroformNative)window.open?.(cloud.publicUrl(item.name),'_blank','noopener');
    return;
  }
  $('#cloud-status').textContent='Downloading '+item.label+'…';
  try{
    const buffer=await cloud.download(item.name);if(request!==openRequest)return;
    showModel(item.label,buffer);$('#cloud-status').textContent=item.label+' loaded';panel(false);
  }catch(error){if(request===openRequest)$('#cloud-status').textContent=error.message;}
}
$('#design-upload').addEventListener('change',async event=>{
  const file=event.target.files?.[0];if(!file)return;event.target.value='';
  const result=validateDesign(file);uploadError(result.error);if(result.error)return;
  const renderable=canRender(file.name);
  if(renderable){
    try{showModel(file.name,await file.arrayBuffer());}
    catch(error){uploadError(error.message);uploadStatus(file.name,'Not uploaded: the model could not be read.');return;}
  }
  if(!cloud.available){uploadStatus(file.name,'Cloud is unavailable here; the file stays on this device.');return;}
  uploadStatus(file.name,'Uploading to cloud…');$('#upload-btn').disabled=true;
  try{
    await cloud.upload(file);
    uploadStatus(file.name,renderable?'Uploaded. Open Cloud models on your phone to load it.':'Uploaded. 3D preview supports STL and OBJ; this file is stored only.');
    refreshCloud();
  }catch(error){uploadError(error.message);uploadStatus(file.name,renderable?'Shown on this device only; the upload failed.':'Upload failed.');}
  finally{$('#upload-btn').disabled=false;}
});
let handFacing='environment';
try{handFacing=window.localStorage.getItem('aeroform-hand-camera')==='user'?'user':'environment';}catch{}
let hands=null,handsOn=false,handContext,gestureModel=null,gestureLoading=null,lastGesture=null;
const gestureCommands=createGestureCommands(),fistOpen=createFistOpenToggle();
// Movement and grabbing state (see src/locomotion.js).
let walkEnabled=true,moves={},grabStart=null,handWalk={suppressUntil:0,active:false},pendingWalk=0,walkFrame=0,lastStepAt=0;
try{walkEnabled=window.localStorage.getItem('aeroform-walk')!=='0';moves=JSON.parse(window.localStorage.getItem('aeroform-moves-v1')||'{}')||{};}catch{}
const stepDetector=createStepDetector(),openHandWalk=createOpenHandWalk();
// VR has no buttons: hand tracking and the clap listener start on entering VR (autoHands remembers who started tracking).
let clap=null,autoHands=false;
// Thumbs up / down: one floor up or down (VR: same spot on the other floor; otherwise the floor filter).
function changeFloor(direction){
  if(!viewer)return;
  const delta=direction==='up'?1:-1;
  if(state.get().vr){
    const level=viewer.changeFloor(delta);
    if(level===null){vrText(delta>0?'Already on the top floor':'Already on the ground floor');return;}
    if(state.get().floor!=='all')state.set('floor',String(level));
    vrText((delta>0?'Thumbs up':'Thumbs down')+' · floor '+level);
  }else{
    const current=state.get().floor,next=delta>0?(current==='1'?'2':current==='all'?'2':null):(current==='2'?'1':current==='all'?'1':null);
    if(!next){vrText(delta>0?'Already on the top floor':'Already on the ground floor');return;}
    state.set('floor',next);vrText((delta>0?'Thumbs up':'Thumbs down')+' · floor '+next);
  }
}
// One to four fingers held up: pick a layer (works in VR and in the normal view).
const FINGER_LAYERS=Object.freeze({point:'thermal',two_fingers:'airflow',three_fingers:'heatloss',four_fingers:'architecture'});
const FINGER_NAMES=Object.freeze({point:'1 finger',two_fingers:'2 fingers',three_fingers:'3 fingers',four_fingers:'4 fingers'});
const layerName=id=>LAYER_TITLES[id]||id;
function setLayer(id,prefix){
  if(!viewer)return;
  if(state.get().layer===id){vrText(prefix+' · already showing '+layerName(id));return;}
  state.set('layer',id);vrText(prefix+' · '+layerName(id));
}
// What each sign does, for the dev view.
function signAction(label){
  if(label==='thumbs_up')return 'up a floor';if(label==='thumbs_down')return 'down a floor';
  if(FINGER_LAYERS[label])return layerName(FINGER_LAYERS[label])+' layer';
  if(label==='open_palm')return 'walk forward'+(state.get().vr?'':' (in VR only)');
  if(label==='fist')return 'clear selection; then open hand: outside / back in';
  return 'no action';
}
// Clap sensitivity (0-1): the slider in the hand dev view, saved on this phone; applies at once.
let clapSensitivity=DEFAULT_CLAP_SENSITIVITY,clapDetector=null,lastClapAt=-Infinity,clapPeakHold=0;
try{const saved=parseFloat(window.localStorage.getItem('aeroform-clap-sensitivity'));if(Number.isFinite(saved))clapSensitivity=Math.max(0,Math.min(1,saved));}catch{}
function startClap(){
  clap?.stop();
  clapDetector=createClapDetector({sensitivity:clapSensitivity});
  clap=startClapListener({detector:clapDetector,onClap:()=>{
      lastClapAt=performance.now();
      if(!viewer||!state.get().vr)return; // outside VR the dev view's microphone test only shows the clap
      if($('#vr-guide').open){closeVrGuide();return;}
      viewer.recenter();vrText('Clap · view recentered');
    },
    onError:message=>{if(state.get().vr)$('#motion-status').textContent=message;}});
}
function stopClap(){clap?.stop();clap=null;clapDetector=null;}
function setClapSensitivity(value){
  clapSensitivity=Math.max(0,Math.min(1,value));clapDetector?.setSensitivity(clapSensitivity);
  try{window.localStorage.setItem('aeroform-clap-sensitivity',String(clapSensitivity));}catch{}
  $('#clap-sensitivity-value').textContent=String(Math.round(clapSensitivity*100));
}
const vrText=text=>{$('#hands-status').textContent=text;$(state.get().vr?'#motion-status':'#scene-status').textContent=text;};
function saveMoves(){try{window.localStorage.setItem('aeroform-moves-v1',JSON.stringify(moves));}catch{}}
// Steps glide you forward at walking pace instead of jumping.
function queueWalk(metres){
  if(!viewer||!state.get().vr)return;
  pendingWalk=Math.min(3,pendingWalk+metres);
  if(walkFrame)return;
  let last=performance.now();
  const tick=now=>{
    const dt=Math.min(.1,Math.max(0,(now-last)/1000));last=now;
    const step=Math.min(pendingWalk,1.4*dt);pendingWalk-=step;
    if(step>0&&state.get().vr)viewer.moveForward(step);
    walkFrame=pendingWalk>1e-3&&state.get().vr?requestAnimationFrame(tick):0;
    if(!walkFrame)pendingWalk=0;
  };
  walkFrame=requestAnimationFrame(tick);
}
function onSteps(count){
  if(!count||!walkEnabled||!state.get().vr)return;
  lastStepAt=performance.now();queueWalk(count*STEP_LENGTH_METRES);
  $('#motion-status').textContent='Walking · '+stepDetector.steps+' steps';
}
// Accelerometer: the Android app sends batches of [ms, |a| - 9.81]; browsers use devicemotion.
window.addEventListener('aeroform-motion',event=>{for(const [time,value] of Array.isArray(event.detail)?event.detail:[])onSteps(stepDetector.update(value,time));});
window.addEventListener('devicemotion',event=>{
  if(window.AeroformNative)return;
  const a=event.accelerationIncludingGravity;if(!a||![a.x,a.y,a.z].every(Number.isFinite))return;
  onSteps(stepDetector.update(Math.hypot(a.x,a.y,a.z)-9.81,event.timeStamp||performance.now()));
});
function toggleOutside(){
  if(!viewer)return;
  if(state.get().vr){
    const outside=viewer.inspect().vrPosition[2]>7;
    if(outside)viewer.goTo([0,1.65,3.6],[0,1.65,-2]);else viewer.goTo([0,1.65,15],[0,2.5,0]);
    vrText(outside?'Fist → open · back inside':'Fist → open · outside the house');
  }else{
    state.set('view',state.get().view==='interior'?'exterior':'interior');
    vrText('Fist → open · '+(state.get().view==='interior'?'interior':'exterior')+' view');
  }
}
// Trained gesture classifier (models/gesture-classifier.json). Held gestures run commands; pinch still selects.
function ensureGestureModel(){
  gestureLoading??=loadGestureClassifier(undefined,window.fetch?.bind(window))
    .then(model=>{gestureModel=model;return model;}).catch(()=>{gestureLoading=null;return null;});
  return gestureLoading;
}
function runGesture(label){
  if(!viewer)return;
  if(label==='thumbs_up'||label==='thumbs_down'){changeFloor(label==='thumbs_up'?'up':'down');return;}
  if(FINGER_LAYERS[label]){setLayer(FINGER_LAYERS[label],FINGER_NAMES[label]);return;}
  if(label==='fist'){viewer.clearSelection();vrText('Fist · selection cleared');}
}
// Open-hand walking moves you a little on every displayed frame. Hand frames arrive only 15-20 times a second,
// so moving on each of them made the view jump in small steps. Stops when the hand frames stop saying "walk".
let glideFrame=0,glideUntil=0;
function glide(){
  if(glideFrame)return;
  let last=performance.now();
  const tick=now=>{
    const dt=Math.min(.05,Math.max(0,(now-last)/1000));last=now;
    if(handWalk.active&&state.get().vr&&viewer&&now<glideUntil){viewer.moveForward(HAND_WALK_SPEED*dt);glideFrame=requestAnimationFrame(tick);}
    else glideFrame=0;
  };
  glideFrame=requestAnimationFrame(tick);
}
function handleGesture(hand,pinched,aspect){
  const now=performance.now();
  const prediction=gestureModel&&hand&&!pinched?gestureModel.predict(hand,aspect):null;
  const sign=prediction&&prediction.confidence>=.6?prediction.label:null;
  const command=Boolean(sign&&sign!=='open_palm'&&sign!=='other'&&sign!=='ok');
  // Open hand (walk): the trained model AND the finger geometry must agree; see isWalkingHand.
  const open=Boolean(hand&&!pinched&&isWalkingHand(hand,prediction,aspect));
  const fist=Boolean(sign==='fist'&&prediction.confidence>=.7);
  if(fistOpen.update(fist?'fist':open?'open':null,now)){toggleOutside();handWalk.suppressUntil=now+1500;}
  // Hand held out open: glide forward (VR only, not while pinching, holding an item or making a sign).
  // Short dropouts (a blurred frame) do not stop it; see createOpenHandWalk.
  const walking=openHandWalk.update(open&&state.get().vr&&!viewer?.grabbing,now);
  const moving=walking&&now>=handWalk.suppressUntil&&!(gestureCommands.state.label);
  if(moving){glideUntil=now+250;glide();if(!handWalk.active)$('#motion-status').textContent='Open hand · moving forward';}
  else if(handWalk.active)$('#motion-status').textContent='Stopped';
  handWalk.active=moving;
  if(!gestureModel)return;
  const fired=gestureCommands.update(prediction,now);
  if(fired){handWalk.suppressUntil=now+800;runGesture(fired);}
  const label=prediction&&prediction.confidence>=.7?prediction.label:null;
  if(label!==lastGesture){lastGesture=label;if(label&&command&&!fired)$('#hands-status').textContent=GESTURE_LABELS[label]+' · hold';}
}
const handCanvas=()=>handContext===undefined?(handContext=$('#hand-overlay').getContext?.('2d')??null):handContext;
function drawHand(hand,pinched){
  const ctx=handCanvas();if(!ctx)return;ctx.clearRect(0,0,160,120);if(!hand)return;
  ctx.fillStyle=pinched?'#ffffff':'#a8dcff';
  for(const point of hand){ctx.beginPath();ctx.arc(point.x*160,point.y*120,2.5,0,Math.PI*2);ctx.fill();}
}
function handsUi(on,message){
  handsOn=on;
  $('#hands-btn').setAttribute('aria-pressed',String(on));$('#hands-btn').classList.toggle('active',on);
  $('#hands-btn').querySelector('i').textContent=on?'✓':'+';
  $('#hand-preview').hidden=!on;
  if(message){$('#hands-status').textContent=message;if(state.get().vr)$('#motion-status').textContent=message;}
}
function handTracker(){
  hands??=createHandTracker({
    video:$('#hand-video'),facingMode:handFacing,
    onStatus:({state:status,message})=>{
      handsUi(status==='starting'||status==='tracking',message);
      viewer?.setReticle(status==='tracking');if(status!=='tracking')drawHand(null);
    },
    onFrame:({hand,pinched,aspect})=>{
      viewer?.setReticle(true,pinched);drawHand(hand,pinched);handleGesture(hand,pinched,aspect);
      if(grabStart&&pinched&&hand&&viewer?.grabbing)viewer.updateGrab(grabOffset(grabStart.hand,hand,{aspect,distance:grabStart.distance,mirrored:hands?.options.facingMode==='user'}));
    },
    // Pinch: grab a movable item (AC unit, vent) under the center mark, otherwise just select.
    onPinch:({hand,aspect}={})=>{
      if(!viewer)return;
      const grabbed=hand?viewer.beginGrab():null;
      if(grabbed){grabStart={hand,aspect,distance:grabbed.distance};vrText('Holding '+grabbed.name+' · move your hand or look around · release to drop');return;}
      const hit=viewer.selectAtCenter();
      vrText(hit?'Selected: '+hit.name+(hit.floor?' · floor '+hit.floor:'')+' · '+hit.distance.toFixed(1)+' m':'Nothing under the center mark');
    },
    onPinchEnd:()=>{
      grabStart=null;const done=viewer?.endGrab();
      if(done){moves[done.group]=done.offset.map(v=>Math.round(v*1000)/1000);saveMoves();vrText('Placed '+done.name);window.dispatchEvent(new CustomEvent('aeroform-moved',{detail:done}));}
    }
  });
  return hands;
}
function toggleHands(){
  if(!viewer)return;
  if(handsOn){hands?.stop();viewer.clearSelection();return;}
  gestureCommands.reset();lastGesture=null;ensureGestureModel();
  handTracker().start();
}
$('#hands-btn').addEventListener('click',toggleHands);

// Hand tracking dev view: camera image with the detected skeleton, live numbers, and what to try next.
const HAND_LINKS=[[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],[10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[17,18],[18,19],[19,20],[0,17]];
let devOpen=false,devFrame=0,devContext,devLogKey='';
const devCanvas=()=>devContext===undefined?(devContext=$('#hand-dev-canvas').getContext?.('2d')??null):devContext;
function devHint(d){
  const age=d.startedAt===null?0:performance.now()-d.startedAt;
  if(window.isSecureContext===false)return 'This page is plain HTTP, so the phone blocks the camera. Use the Android app, or open the site on localhost or HTTPS.';
  if(d.state==='error')return d.message;
  if(d.state==='off')return 'Press Start tracking. Holding the phone in your hand? Switch to the front camera so it can see you.';
  if(d.state==='starting')return d.message;
  if(!d.video||d.video.readyState<2)return age>2000?'The camera started but no frames are arriving. Close other apps using the camera, or switch camera.':'Waiting for camera frames…';
  if(!d.frames)return age>2000?'Frames arrive but the hand model has not answered yet.':'Starting detection…';
  if(!d.hand){const since=d.lastHandAt===null?age:performance.now()-d.lastHandAt;return since>3000?'Camera and model work, but no hand is found. Show your whole hand 30–60 cm from the camera in good light, or switch camera.':'Looking for a hand…';}
  return 'Hand found. Pinch thumb and index to select; hold open palm, point or fist for commands.';
}
function renderDev(){
  if(!devOpen)return;
  const tracker=handTracker(),d=tracker.diagnostics(),ctx=devCanvas();
  if(ctx){
    const w=320,h=240,video=$('#hand-video');
    ctx.fillStyle='#000';ctx.fillRect(0,0,w,h);ctx.save();
    if(d.facingMode==='user'){ctx.translate(w,0);ctx.scale(-1,1);}
    if(d.video&&d.video.readyState>=2){try{ctx.drawImage(video,0,0,w,h);}catch{}}
    if(d.hand){
      ctx.lineWidth=2;ctx.strokeStyle='#55e5d0';ctx.beginPath();
      for(const [a,b] of HAND_LINKS){ctx.moveTo(d.hand[a].x*w,d.hand[a].y*h);ctx.lineTo(d.hand[b].x*w,d.hand[b].y*h);}
      ctx.stroke();
      ctx.strokeStyle=d.pinched?'#ffffff':'#f39a61';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(d.hand[4].x*w,d.hand[4].y*h);ctx.lineTo(d.hand[8].x*w,d.hand[8].y*h);ctx.stroke();
      ctx.fillStyle='#9fd8ff';for(const p of d.hand){ctx.beginPath();ctx.arc(p.x*w,p.y*h,3,0,Math.PI*2);ctx.fill();}
    }
    ctx.restore();
  }
  $('#hand-dev-state').textContent=d.state;$('#hand-dev-state').dataset.state=d.state;
  $('#hand-dev-hint').textContent=devHint(d);
  $('#hand-dev-toggle').textContent=handsOn?'Stop tracking':'Start tracking';
  $('#hand-dev-camera').textContent='Camera: '+(tracker.options.facingMode==='user'?'front':'rear');
  $('#hd-status').textContent=d.message;
  $('#hd-camera').textContent=(d.facingMode==='user'?'Front':'Rear')+(d.cameraLabel?' · '+d.cameraLabel:'');
  $('#hd-video').textContent=d.video&&d.video.width?d.video.width+'×'+d.video.height+' · ready '+d.video.readyState:'no frames';
  $('#hd-model').textContent=(d.model||'not loaded')+(d.mode?' · '+d.mode:'');
  $('#hd-fps').textContent=d.frames?d.fps+' fps · '+d.detectMs.toFixed(0)+' ms · '+d.frames+' frames':'not running';
  $('#hd-hand').textContent=d.hand?'hand'+(d.presence!==null?' '+Math.round(d.presence*100)+'%':'')+' · seen in '+Math.round(100*d.handFrames/Math.max(1,d.frames))+'% of frames':'none'+(d.frames?' · seen in '+Math.round(100*d.handFrames/d.frames)+'% of frames':'');
  $('#hd-walk').textContent=(walkEnabled?'on':'off')+' · '+stepDetector.steps+' steps · accel '+stepDetector.value.toFixed(2)+' m/s²'+(handWalk.active?' · hand moving':'');
  $('#hd-grab').textContent=viewer?.grabbing?'holding '+viewer.grabbing.name:'–';
  $('#hd-pinch').textContent=d.ratio===null?'–':d.ratio.toFixed(2)+(d.pinched?' · PINCHED':'');
  $('#hd-pinch-bar').style.width=d.ratio===null?'0%':Math.min(100,d.ratio/1.5*100).toFixed(1)+'%';
  const aspect=d.video&&d.video.width&&d.video.height?d.video.width/d.video.height:4/3;
  const prediction=d.hand&&gestureModel?gestureModel.predict(d.hand,aspect):null;
  const held=gestureCommands.state,shown=held.label??(prediction&&prediction.confidence>=.6?prediction.label:null);
  $('#hd-sign').textContent=!d.hand?'no hand':!gestureModel?'model loading':shown?GESTURE_LABELS[shown]+' → '+signAction(shown)+(held.label?(held.fired?' · done':' · holding'):''):'no clear sign';
  $('#hd-sign-bar').style.width=(held.label?held.progress*100:0).toFixed(0)+'%';
  // Clap meter: loudest recent sound against the level a clap must pass (log scale, -60 to 0 dB).
  const mic=clap?.diagnostics(),db=v=>Math.max(0,Math.min(100,(20*Math.log10(Math.max(v,1e-4))+60)/60*100));
  clapPeakHold=mic?.state==='listening'?Math.max(mic.peak??0,clapPeakHold*.9):0;
  $('#hd-clap-bar').style.width=db(clapPeakHold).toFixed(1)+'%';$('#hd-clap-mark').style.left=(mic?.threshold?db(mic.threshold):0).toFixed(1)+'%';
  $('#hd-clap').textContent=!mic?'microphone off':mic.state!=='listening'?mic.message:(performance.now()-lastClapAt<1200?'CLAP heard':'listening')+' · '+mic.claps+' claps';
  $('#hd-clap-test').textContent=state.get().vr?'Microphone on (VR)':clap?'Stop microphone test':'Test microphone';
  for(const label of ['open_palm','fist','point','two_fingers','three_fingers','four_fingers','thumbs_up','thumbs_down','ok','other']){
    const p=prediction?prediction.probabilities[gestureModel.classes.indexOf(label)]??0:null;
    if(!$('#hd-g-'+label))continue;
    $('#hd-g-'+label).style.width=p===null?'0%':(p*100).toFixed(1)+'%';
    $('#hd-gv-'+label).textContent=p===null?(gestureModel?'–':'not loaded'):Math.round(p*100)+'%';
  }
  const key=d.events.map(e=>e.at+e.message).join('|');
  if(key!==devLogKey){
    devLogKey=key;
    $('#hand-dev-log').replaceChildren(...d.events.map(e=>{const li=document.createElement('li');li.textContent=(e.at/1000).toFixed(1)+'s  '+e.message;return li;}));
  }
}
function devLoop(){cancelAnimationFrame(devFrame);if(devOpen)devFrame=requestAnimationFrame(()=>{renderDev();devLoop();});}
function setDev(open){
  devOpen=open;$('#hand-dev').hidden=!open;
  document.body.classList.toggle('hand-dev-open',open);
  try{window.localStorage.setItem('aeroform-hand-dev',open?'1':'0');}catch{}
  if(open){panel(false);ensureGestureModel();renderDev();devLoop();}else cancelAnimationFrame(devFrame);
}
$('#hand-dev-open').addEventListener('click',()=>setDev(true));
$('#hand-dev-close').addEventListener('click',()=>setDev(false));
$('#hand-dev-toggle').addEventListener('click',()=>{toggleHands();renderDev();});
// Clap sensitivity slider and a microphone test outside VR (in VR the clap listener is already running).
$('#clap-sensitivity').value=String(Math.round(clapSensitivity*100));$('#clap-sensitivity-value').textContent=String(Math.round(clapSensitivity*100));
$('#clap-sensitivity').addEventListener('input',event=>setClapSensitivity(Number(event.target.value)/100));
$('#hd-clap-test').addEventListener('click',()=>{if(state.get().vr)return;if(clap)stopClap();else startClap();renderDev();});
$('#hand-dev-camera').addEventListener('click',async()=>{
  const tracker=handTracker();handFacing=tracker.options.facingMode==='user'?'environment':'user';
  try{window.localStorage.setItem('aeroform-hand-camera',handFacing);}catch{}
  await tracker.setOptions({facingMode:handFacing});renderDev();
});
function syncWalk(){$('#vr-walk-btn').setAttribute('aria-pressed',String(walkEnabled));$('#vr-walk-btn').classList.toggle('active',walkEnabled);$('#vr-walk-btn').querySelector('i').textContent=walkEnabled?'✓':'+';$('#vr-walk-status').textContent=walkEnabled?'On · step in place or walk to move forward':'Off';}
$('#vr-walk-btn').addEventListener('click',()=>{walkEnabled=!walkEnabled;stepDetector.reset();try{window.localStorage.setItem('aeroform-walk',walkEnabled?'1':'0');}catch{}syncWalk();$('#motion-status').textContent=walkEnabled?'Walk on · step in place or walk to move forward':'Walk off';});
syncWalk();
// Environmental analysis: the simulation adapter, its layers in the 3D view, and the Analysis panel.
analysisPanel=createAnalysisPanel({$,doc:document,storage:(()=>{try{return window.localStorage;}catch{return null;}})(),
  getConditions:()=>conditions,getMoves:()=>moves,
  setMoves:next=>{moves={...next};saveMoves();viewer?.applyMoves(moves);},
  onVisualization:viz=>{analysisViz=viz;viewer?.setAnalysis(viz);$('#legend-label').textContent=legendText(state.get());},
  onSummary:(result,season)=>{$('#analysis-summary').textContent=(season==='current'?'Today':season[0].toUpperCase()+season.slice(1))+': '+result.totals.electricKWh.toFixed(1)+' kWh electricity · '+result.totals.co2Kg.toFixed(1)+' kg CO₂e';},
  surrogate:typeof window.fetch==='function'?loadEnergySurrogate('energyplus',window.fetch.bind(window)):null});
function openAnalysis(){panel(false);$('#analysis-modal').showModal();analysisPanel.run();}
$('#analysis-btn').addEventListener('click',openAnalysis);
$('#analysis-pill').addEventListener('click',openAnalysis);
$('#analysis-top-btn').addEventListener('click',openAnalysis);
$('#close-analysis').addEventListener('click',()=>$('#analysis-modal').close());
window.addEventListener('aeroform-moved',()=>analysisPanel.run());
$('#reset-moves-btn').addEventListener('click',()=>{moves={};saveMoves();viewer?.applyMoves(moves);$('#scene-status').textContent='Moved items reset';window.dispatchEvent(new CustomEvent('aeroform-moved',{detail:null}));});
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='hidden'){if(handsOn)hands?.stop();stopClap();}});
// Open from computer: view an STL/OBJ on this device only; nothing is uploaded.
$('#local-upload').addEventListener('change',async event=>{
  const file=event.target.files?.[0];if(!file)return;event.target.value='';
  const result=validateDesign(file);uploadError(result.error);if(result.error)return;
  if(!canRender(file.name)){uploadError('3D preview supports STL and OBJ. Use Upload to phone to store other files.');return;}
  try{showModel(file.name,await file.arrayBuffer());uploadStatus(file.name,'Opened on this device only. Use Upload to phone to share it.');panel(false);}
  catch(error){uploadError(error.message);}
});
$('#cloud-refresh').addEventListener('click',refreshCloud);
$('#demo-btn').addEventListener('click',showDemo);
document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')refreshCloud();});
for(const key of ['view','floor','layer'])document.querySelectorAll(`[data-${key}]:not(:disabled),[data-${key}][data-scene]`).forEach(button=>{
  button.addEventListener('click',()=>{if(!viewer)return;state.set(key,button.dataset[key]);panel(false);});
});
$('#reset-btn').addEventListener('click',()=>viewer?.reset());

function syncOptics(save=false){
  const calculated=calculateAutomaticFit(),automatic=lensFit.mode==='auto';
  optics=automatic?calculated.optics:lensFit.manual;
  for(const mode of ['auto','manual']){
    $('#lens-mode-'+mode).classList.toggle('active',lensFit.mode===mode);
    $('#lens-mode-'+mode).setAttribute('aria-pressed',String(lensFit.mode===mode));
  }
  $('#lens-manual-controls').hidden=automatic;$('#lens-manual-note').hidden=automatic;
  $('#lens-auto-details').hidden=!automatic;$('#lens-reset').hidden=automatic;
  $('#lens-auto-spacing').textContent=calculated.optics.spacing+' mm';
  $('#lens-auto-centers').textContent=calculated.centerPercent.map(x=>x.toFixed(1)+'%').join(' / ');
  $('#lens-auto-size').textContent=calculated.diameterMm.toFixed(1)+' mm';
  $('#lens-auto-screen').textContent=calculated.screenMm.map(x=>x.toFixed(1)).join(' × ')+' mm';
  for(const key of Object.keys(DEFAULT_OPTICS)){
    $('#lens-'+key).value=String(optics[key]);
    $('#lens-'+key).disabled=automatic;
    $('#lens-'+key+'-value').textContent=Number(optics[key].toFixed(1))+(['spacing','height'].includes(key)?' mm':key==='fov'?'°':'%');
  }
  viewer?.setOptics(optics);
  if(save){try{window.localStorage.setItem('aeroform-lens-fit-v2',JSON.stringify(lensFit));}catch{}}
}
for(const mode of ['auto','manual'])$('#lens-mode-'+mode).addEventListener('click',()=>{lensFit.mode=mode;syncOptics(true);});
for(const key of Object.keys(DEFAULT_OPTICS))$('#lens-'+key).addEventListener('input',event=>{
  if(lensFit.mode!=='manual')return;
  lensFit.manual=normalizeOptics({...lensFit.manual,[key]:Number(event.target.value)});syncOptics(true);
});
function setCalibration(enabled){
  calibrating=enabled;viewer?.setCalibration(enabled);
  $('#alignment-btn').hidden=!enabled;
  $('#alignment-note').hidden=!enabled;
}
// Lens fit lives in the menu: it opens VR (if needed) with the lens settings on top.
function openLensFit(){if(!viewer)return;if(!state.get().vr)enterVR({guide:false});$('#lens-modal').showModal();}
$('#lens-fit-btn').addEventListener('click',openLensFit);
$('#close-lens').addEventListener('click',()=>$('#lens-modal').close());
$('#lens-done').addEventListener('click',()=>$('#lens-modal').close());
$('#lens-reset').addEventListener('click',()=>{if(lensFit.mode==='manual'){lensFit.manual=calculateAutomaticFit().optics;syncOptics(true);}});
$('#lens-target').addEventListener('click',()=>{setCalibration(true);$('#lens-modal').close();});
$('#alignment-btn').addEventListener('click',()=>{setCalibration(false);$('#lens-modal').showModal();});
syncOptics();

// Phone VR guide: how the hand signs and clap work, shown on entering VR (unless turned off). Tap Start or clap.
function vrGuideWanted(){try{return window.localStorage.getItem('aeroform-vr-guide')!=='0';}catch{return true;}}
function closeVrGuide(){
  if(!$('#vr-guide').open)return;
  if($('#vr-guide-skip').checked){try{window.localStorage.setItem('aeroform-vr-guide','0');}catch{}}
  $('#vr-guide').close();
  if(state.get().vr)$('#motion-status').textContent=VR_HINT;
}
$('#vr-guide-ok').addEventListener('click',closeVrGuide);
$('#vr-guide').addEventListener('cancel',event=>{event.preventDefault?.();closeVrGuide();});
const VR_HINT='Thumbs up/down: floor · 1–4 fingers: layer · open hand: walk · clap: recenter · Back: leave';
function exitVR() {
  if(!state.get().vr)return;
  $('#lens-modal').close();$('#vr-guide').close();setCalibration(false);
  vrSession++;state.set('vr',false);hadFullscreen=false;
  stopClap();if(autoHands&&handsOn)hands?.stop();autoHands=false;openHandWalk.reset();
  if(window.history?.state?.aeroformVr)window.history.back();
  try{window.AeroformNative?.setVrMode(false);}catch{}
  try{screen.orientation?.unlock?.();}catch{}
  if(document.fullscreenElement)Promise.resolve(document.exitFullscreen()).catch(()=>{});
  $('#vr-btn').focus();
}
function enterVR(options) {
  if(!viewer)return;
  panel(false);state.set('vr',true);const session=++vrSession;
  $('#motion-status').textContent=VR_HINT;
  if(options?.guide!==false&&vrGuideWanted()){$('#vr-guide-skip').checked=false;$('#vr-guide').showModal();}
  // No buttons in VR: hand signs need the camera, and the clap needs the microphone. Both stop on exit.
  if(!handsOn){autoHands=true;toggleHands();}
  startClap();
  // Browser Back leaves VR instead of the page (the Android app sends its Back button as aeroform-back).
  if(!window.AeroformNative&&!window.history?.state?.aeroformVr){try{window.history?.pushState({aeroformVr:true},'');}catch{}}
  const native=Boolean(window.AeroformNative);
  if(native){try{window.AeroformNative.setVrMode(true);}catch{}}
  else if(!window.isSecureContext)$('#motion-status').textContent='Drag to look · head tracking needs HTTPS';
  else if(typeof window.DeviceOrientationEvent?.requestPermission==='function'){
    try{Promise.resolve(window.DeviceOrientationEvent.requestPermission()).then(permission=>{
      if(session===vrSession&&permission!=='granted')$('#motion-status').textContent='Motion not allowed · drag to look';
    }).catch(()=>{if(session===vrSession)$('#motion-status').textContent='Motion unavailable · drag to look';});}catch{$('#motion-status').textContent='Motion unavailable · drag to look';}
  }
  if(!native&&document.documentElement.requestFullscreen){
    try{Promise.resolve(document.documentElement.requestFullscreen()).then(()=>{
      if(session!==vrSession){if(document.fullscreenElement)document.exitFullscreen().catch(()=>{});return;}
      hadFullscreen=Boolean(document.fullscreenElement);
      if(screen.orientation?.lock)Promise.resolve(screen.orientation.lock('landscape')).catch(()=>{});
    }).catch(()=>{});}catch{}
  }
}
$('#vr-btn').addEventListener('click',enterVR);
window.addEventListener('popstate',()=>{if(state.get().vr)exitVR();});
document.addEventListener('fullscreenchange',()=>{if(hadFullscreen&&!document.fullscreenElement)exitVR();});
window.addEventListener('keydown',event=>{
  if(event.key==='Escape'){if($('#vr-guide').open){closeVrGuide();return;}if($('#lens-modal').open){$('#lens-modal').close();return;}if($('#conditions-modal').open){$('#conditions-modal').close();return;}if($('#analysis-modal').open){$('#analysis-modal').close();return;}exitVR();panel(false);return;}
  if($('#help-modal').open||$('#conditions-modal').open||$('#analysis-modal').open||['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName)||!viewer||state.get().vr)return;
  if(event.key==='1')state.set('view','interior');if(event.key==='2')state.set('view','exterior');if(event.key.toLowerCase()==='r')viewer.reset();
});
window.addEventListener('aeroform-back',()=>{if($('#vr-guide').open)closeVrGuide();else if($('#lens-modal').open)$('#lens-modal').close();else if($('#conditions-modal').open)$('#conditions-modal').close();else if($('#analysis-modal').open)$('#analysis-modal').close();else if(state.get().vr)exitVR();else if($('#help-modal').open)$('#help-modal').close();else panel(false);});

function showFailure(error) {
  if(handsOn)hands?.stop();exitVR();document.querySelectorAll('[data-scene]').forEach(b=>b.disabled=true);
  $('#load-panel').hidden=false;$('#load-panel').classList.add('error');$('#load-title').textContent='The 3D viewer could not start';
  $('#load-message').textContent=error.message||String(error);$('#retry-btn').hidden=false;$('#scene-status').textContent='Viewer unavailable';
  document.body.dataset.viewer='error';
}
async function loadViewer() {
  const attempt=++generation;
  viewer?.dispose();viewer=null;$('#load-panel').hidden=false;$('#load-panel').classList.remove('error');$('#load-title').textContent='Opening the house…';$('#retry-btn').hidden=true;
  let timeout;
  try{
    const module=await Promise.race([import('./src/viewer.js'),new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('The viewer took too long to load. Retry or reload this page.')),10000);})]);
    if(attempt!==generation)return;
    viewer=module.createViewer(canvas,{onMotion:message=>$('#motion-status').textContent=message,onError:message=>showFailure(new Error(message))});
    viewer.applyMoves(moves);
    if(analysisViz)viewer.setAnalysis(analysisViz);
    syncOptics();
    viewer.update(state.get(),'view');document.querySelectorAll('[data-scene]').forEach(b=>b.disabled=false);
    $('#load-panel').hidden=true;$('#scene-status').textContent='';document.body.dataset.viewer='ready';
  }catch(error){if(attempt===generation)showFailure(error);}finally{clearTimeout(timeout);}
}
$('#retry-btn').addEventListener('click',loadViewer);
loadViewer();
refreshCloud();
analysisPanel.run();
try{if(/[?&]dev=1/.test(window.location?.search||'')||window.localStorage.getItem('aeroform-hand-dev')==='1')setDev(true);}catch{}

// Read-only diagnostics for repeatable browser tests, with no model/prediction claims.
window.aeroform={inspect:()=>({...viewer?.inspect(),status:document.body.dataset.viewer,lensMode:lensFit.mode,cloudModel:activeModel?.label??null,handTracking:handsOn,clap:clap?.diagnostics().state??'off',clapSensitivity,claps:clap?.diagnostics().claps??0,analysis:analysisPanel?.result?{electricKWh:analysisPanel.result.totals.electricKWh,zones:analysisPanel.result.zones.length,season:analysisPanel.season}:null,walk:{enabled:walkEnabled,steps:stepDetector.steps},moves:{...moves},handDev:devOpen,handDiagnostics:()=>hands?.diagnostics()??null}),exitVR,
  // Run a hand sign's action as if it had been held (tests and demos without a camera).
  runSign:label=>runGesture(label)};
if('serviceWorker' in navigator && window.isSecureContext && !window.AeroformNative){
  navigator.serviceWorker.register('./sw.js',{updateViaCache:'none'}).then(reg=>reg.update()).catch(()=>{});
  let refreshing=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{if(!refreshing){refreshing=true;location.reload();}});
}
