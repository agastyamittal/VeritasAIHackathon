const CACHE='aeroform-v38';
const ASSETS=['./','./index.html','./styles.css?v=12','./app.js?v=12','./src/viewer.js','./src/viewer-state.js','./src/vr-optics.js','./src/math.js','./src/building.js','./src/mesh.js','./src/hand-tracking.js','./src/mediapipe-detector.js','./src/mediapipe-worker.js','./vendor/mediapipe/vision_bundle.mjs','./vendor/mediapipe/wasm/vision_wasm_internal.js','./vendor/mediapipe/wasm/vision_wasm_internal.wasm','./vendor/mediapipe/hand_landmarker.task','./src/conditions.js','./src/locomotion.js','./src/clap-detector.js','./src/analysis-panel.js','./src/analysis-charts.js','./src/ai/registry.js','./src/simulation/index.js','./src/simulation/constructions.js','./src/simulation/model.js','./src/simulation/thermal.js','./src/simulation/weather.js','./src/simulation/optimizer.js','./src/simulation/visualize.js','./src/gesture-classifier.js','./models/gesture-classifier.json','./samples/modern-cabin.obj','./samples/twisting-tower.stl','./samples/geodesic-dome.obj','./samples/spiral-stair.stl','./src/energy-surrogate.js','./src/simulation/surrogate-features.js','./models/energy-surrogate-energyplus.json','./src/cloud.js','./src/cloud-config.js','./manifest.webmanifest','./public/aeroform-icon.svg'];
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('aeroform-')&&key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  if(event.request.method!=='GET'||new URL(event.request.url).origin!==self.location.origin)return;
  event.respondWith(fetch(event.request).then(response=>{
    if(response.ok){const copy=response.clone();event.waitUntil(caches.open(CACHE).then(cache=>cache.put(event.request,copy)));}
    return response;
  }).catch(async()=>{
    const hit=await caches.match(event.request);
    if(hit)return hit;
    if(event.request.mode==='navigate')return (await caches.match('./index.html'))||Response.error();
    return Response.error();
  }));
});
