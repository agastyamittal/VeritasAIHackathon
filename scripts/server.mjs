import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url));
const types={'.html':'text/html; charset=utf-8','.obj':'model/obj','.stl':'model/stl','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.webmanifest':'application/manifest+json','.svg':'image/svg+xml','.apk':'application/vnd.android.package-archive','.mjs':'text/javascript; charset=utf-8','.wasm':'application/wasm','.task':'application/octet-stream','.json':'application/json'};
const allowed=new Set(['index.html','app.js','styles.css','manifest.webmanifest','sw.js','src/viewer.js','src/viewer-state.js','src/vr-optics.js','src/math.js','src/building.js','src/hand-tracking.js','src/mediapipe-detector.js','src/mediapipe-worker.js','vendor/mediapipe/vision_bundle.mjs','vendor/mediapipe/wasm/vision_wasm_internal.js','vendor/mediapipe/wasm/vision_wasm_internal.wasm','vendor/mediapipe/hand_landmarker.task','src/conditions.js','src/locomotion.js','src/clap-detector.js','src/analysis-panel.js','src/analysis-charts.js','src/ai/registry.js','src/simulation/index.js','src/simulation/constructions.js','src/simulation/model.js','src/simulation/thermal.js','src/simulation/weather.js','src/simulation/optimizer.js','src/simulation/visualize.js','src/gesture-classifier.js','models/gesture-classifier.json','samples/modern-cabin.obj','samples/twisting-tower.stl','samples/geodesic-dome.obj','samples/spiral-stair.stl','src/energy-surrogate.js','src/simulation/surrogate-features.js','models/energy-surrogate-energyplus.json','src/mesh.js','src/cloud.js','src/cloud-config.js','public/aeroform-icon.svg','releases/AEROFORM-debug.apk']);
// log: optional function; when given, each page open (index.html) is reported with the device's address.
export function createServer({ log = null } = {}) {
  return http.createServer(async(req,res)=>{
    if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{'Allow':'GET, HEAD'}).end();return;}
    try{
      const url=new URL(req.url,'http://localhost');
      const name=decodeURIComponent(url.pathname).replace(/^\//,'')||'index.html';
      if(log&&name==='index.html')log(`${new Date().toLocaleTimeString()}  page opened from ${String(req.socket.remoteAddress).replace(/^::ffff:/,'')}`);
      if(!allowed.has(name)){res.writeHead(404).end('Not found');return;}
      const file=path.join(root,name), info=await stat(file);
      const headers={'Content-Type':types[path.extname(file)],'Content-Length':info.size,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'};
      if(name.endsWith('.apk'))headers['Content-Disposition']='attachment; filename="AEROFORM-debug.apk"';
      res.writeHead(200,headers);
      res.end(req.method==='HEAD'?undefined:await readFile(file));
    }catch{res.writeHead(404).end('Not found');}
  });
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const port=Number(process.env.PORT||8787);
  const server=createServer({log:message=>console.log(message)});
  server.on('error',error=>{console.error(error.message);process.exitCode=1;});
  // Print the network (IP) addresses first: other devices on the same Wi-Fi open those. localhost only works on this computer.
  server.listen(port,'0.0.0.0',async()=>{
    const { networkInterfaces } = await import('node:os');
    // Real Wi-Fi / Ethernet adapters first; virtual ones (VMware, Hyper-V, VirtualBox, WSL) are listed after, marked.
    const virtual=/vmware|virtual|vethernet|vbox|hyper-v|wsl|loopback|bluetooth/i;
    // Windows often names virtual adapters "Ethernet 2"; their host address usually ends in .1, so that counts too.
    const all=Object.entries(networkInterfaces()).flatMap(([name,list])=>(list||[]).filter(a=>a.family==='IPv4'&&!a.internal).map(a=>({name,ip:a.address,virtual:virtual.test(name)||/\.1$/.test(a.address)})))
      .sort((a,b)=>(/wi-?fi|wlan/i.test(b.name)?1:0)-(/wi-?fi|wlan/i.test(a.name)?1:0));
    console.log('AEROWAY is running. On this Wi-Fi, open:');
    for(const a of all.filter(a=>!a.virtual))console.log(`  http://${a.ip}:${port}   (${a.name})`);
    for(const a of all.filter(a=>a.virtual))console.log(`  http://${a.ip}:${port}   (${a.name}, probably a virtual adapter)`);
    console.log(`  http://localhost:${port} (this computer only)`);
  });
}
