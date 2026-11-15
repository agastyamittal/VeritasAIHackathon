import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from '../scripts/server.mjs';
import { SUPABASE_URL } from '../src/cloud-config.js';

// Use an existing installation via PLAYWRIGHT_MODULE, or install Playwright normally.
const require=createRequire(import.meta.url);
let chromium;
try { ({chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright')); }
catch { throw new Error('Browser tests need Playwright: npm install --no-save playwright, then npx playwright install chromium. Or set PLAYWRIGHT_MODULE to an existing installation.'); }
const out=path.resolve('test-results');await mkdir(out,{recursive:true});
const server=createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}`;
const results=[];let browser;
async function check(name,fn) {try{await fn();results.push({name,status:'passed'});console.log('PASS',name);}catch(e){results.push({name,status:'failed',error:e.message});throw e;}}
try {
  browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{})});
  for(const config of [
    {name:'desktop',viewport:{width:1440,height:900},isMobile:false,hasTouch:false},
    {name:'phone-portrait',viewport:{width:412,height:915},isMobile:true,hasTouch:true},
    {name:'phone-landscape',viewport:{width:915,height:412},isMobile:true,hasTouch:true}
  ]) {
    const {name,...options}=config;
    const context=await browser.newContext({...options,serviceWorkers:'block'});
    // Cloud sharing lists Supabase files at startup; answer it locally (empty list) so the run stays offline.
    // Any other outside request (CDN, fonts, model downloads) still fails the test.
    await context.route(SUPABASE_URL+'/**',route=>route.fulfill({status:200,contentType:'application/json',body:'[]'}));
    const page=await context.newPage(),errors=[],external=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',r=>{if(!r.url().startsWith(base)&&!r.url().startsWith(SUPABASE_URL))external.push(r.url());});
    await page.addInitScript(()=>{
      // On the prototype: init scripts can run before documentElement exists (e.g. on reload).
      Element.prototype.requestFullscreen=()=>Promise.reject(new Error('Fullscreen denied in regression case'));
      if(window.DeviceOrientationEvent)window.DeviceOrientationEvent.requestPermission=()=>Promise.reject(new Error('Motion denied in regression case'));
    });
    const click=selector=>options.hasTouch?page.locator(selector).tap():page.locator(selector).click();
    const openPanel=async()=>{if(options.isMobile)await click('#panel-btn');};
    await check(name+' starts with local 3D assets',async()=>{
      await page.goto(base);await page.waitForSelector('body[data-viewer="ready"]');
      await page.waitForFunction(()=>window.aeroform.inspect().frames>3);
      assert.equal(external.length,0);assert.ok(await page.locator('#viewport').isVisible());
      assert.equal(await page.locator('#vr-btn').isEnabled(),true);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.screenshot({path:path.join(out,name+'.png')});
    });
    await check(name+' help and camera/view controls',async()=>{
      // Phones have Help inside the ☰ menu (0.4.0 layout); it closes the menu when it opens.
      if(options.isMobile){await openPanel();await click('#menu-help-btn');}else await click('#help-btn');
      assert.equal(await page.locator('#help-modal').isVisible(),true);await click('#close-help');
      // Analysis is one click away on every layout: the top bar on desktop, the dock button on phones.
      const opener=options.isMobile?'#analysis-pill':'#analysis-top-btn';assert.equal(await page.locator(opener).isVisible(),true,opener+' visible');
      await click(opener);assert.equal(await page.locator('#analysis-modal').isVisible(),true);await page.keyboard.press('Escape');assert.equal(await page.locator('#analysis-modal').isVisible(),false);
      await openPanel();await click('[data-view="exterior"]');assert.equal(await page.locator('#layer-label').textContent(),'Exterior · Architecture');
      await openPanel();await click('[data-view="interior"]');
      for(const floor of ['1','2','all']){await click(`[data-floor="${floor}"]`);assert.equal((await page.evaluate(()=>aeroform.inspect())).state.floor,floor);}
      await click('#reset-btn');
    });
    await check(name+' all enabled visualization layers',async()=>{
      // Menu rows: the bold title sits on its own line above the description (not run together).
      await openPanel();
      for(const id of ['[data-layer="architecture"]','#hands-btn','#hand-dev-open','#lens-fit-btn','#vr-walk-btn']){
        const r=await page.locator(id).evaluate(el=>{const b=el.querySelector('b').getBoundingClientRect(),s=el.querySelector('small').getBoundingClientRect();return{bBottom:b.bottom,sTop:s.top,display:getComputedStyle(el.querySelector('b').parentElement).display};});
        assert.equal(r.display,'grid',id);assert.ok(r.sTop>=r.bBottom-1,id+' description below the title');
      }
      if(options.isMobile)await click('#close-panel');
      for(const layer of ['airflow','thermal','heatloss','architecture']){
        await openPanel();await click(`[data-layer="${layer}"]`);
        assert.equal((await page.evaluate(()=>aeroform.inspect())).state.layer,layer);
        assert.equal(await page.locator('#simulation-note').isVisible(),layer!=='architecture');
        if(name==='desktop')await page.screenshot({path:path.join(out,name+'-'+layer+'.png')});
      }
    });
    await check(name+' file chooser and safe filename display',async()=>{
      await openPanel();const chooser=page.waitForEvent('filechooser');await click('#upload-btn');
      await (await chooser).setFiles({name:'<img src=x onerror=alert(1)>.pdf',mimeType:'application/pdf',buffer:Buffer.from('%PDF-1.4 demo')});
      assert.equal(await page.locator('#upload-title').textContent(),'<img src=x onerror=alert(1)>.pdf');
      assert.equal(await page.locator('.upload-card img').count(),0);
      // Any file type is accepted since 0.4.0; an empty file is still rejected with a visible error.
      await page.locator('#design-upload').setInputFiles({name:'empty.stl',mimeType:'application/octet-stream',buffer:Buffer.alloc(0)});
      assert.equal(await page.locator('#upload-error').isVisible(),true);
      if(options.isMobile)await click('#close-panel');
    });
    await check(name+' VR has no buttons, works when fullscreen and motion are denied; Escape and Back leave; reentry works',async()=>{
      for(let i=0;i<3;i++){
        await click('#vr-btn');assert.equal(await page.locator('#stereo-hud').isVisible(),true);
        // The controls guide opens on entering VR and fits the screen; Start closes it.
        assert.equal(await page.locator('#vr-guide').isVisible(),true,'VR guide shown');
        if(i===0){const g=await page.locator('#vr-guide').boundingBox();assert.ok(g.x>=0&&g.y>=0&&g.x+g.width<=options.viewport.width+1&&g.y+g.height<=options.viewport.height+1,'guide fits the screen');
          assert.equal(await page.locator('#vr-guide-ok').isVisible(),true);await page.screenshot({path:path.join(out,name+'-vr-guide.png')});}
        await click('#vr-guide-ok');assert.equal(await page.locator('#vr-guide').isVisible(),false);
        assert.equal((await page.evaluate(()=>aeroform.inspect())).state.vr,true);
        const bounds=await page.locator('#viewport').boundingBox();assert.ok(Math.abs(bounds.width-options.viewport.width)<2);
        assert.equal(await page.locator('#stereo-hud button:visible').count(),0,'no buttons in VR');
        if(i===0)await page.screenshot({path:path.join(out,name+'-vr.png')});
        // Leave with Escape, or with the browser's Back (which must not leave the page).
        if(i===1){await page.goBack();await page.waitForFunction(()=>!aeroform.inspect().state.vr);assert.equal(page.url().startsWith(base),true);}
        else await page.keyboard.press('Escape');
        assert.equal((await page.evaluate(()=>aeroform.inspect())).state.vr,false);
        assert.equal(await page.locator('#vr-btn').isVisible(),true);
      }
    });
    await check(name+' lens fit renders black corners, matching alignment targets and persists adjustments',async()=>{
      // Lens fit is in the menu; it opens VR with the lens settings on top.
      await openPanel();await click('#lens-fit-btn');assert.equal(await page.locator('#lens-modal').isVisible(),true);
      assert.equal((await page.evaluate(()=>aeroform.inspect())).state.vr,true);
      assert.equal((await page.evaluate(()=>aeroform.inspect())).lensMode,'auto');
      assert.equal(await page.locator('#lens-auto-details').isVisible(),true);
      await click('#lens-mode-manual');assert.equal(await page.locator('#lens-manual-controls').isVisible(),true);
      await page.locator('#lens-spacing').evaluate(input=>{input.value='65';input.dispatchEvent(new Event('input',{bubbles:true}));});
      assert.equal((await page.evaluate(()=>aeroform.inspect())).optics.spacing,65);
      await click('#lens-mode-auto');assert.equal((await page.evaluate(()=>aeroform.inspect())).optics.spacing,62);
      await click('#lens-mode-manual');assert.equal((await page.evaluate(()=>aeroform.inspect())).optics.spacing,65);
      await page.screenshot({path:path.join(out,name+'-lens-fit.png')});
      await click('#lens-target');assert.equal((await page.evaluate(()=>aeroform.inspect())).calibrating,true);
      const pixels=await page.evaluate(async()=>{
        const {lensLayout}=await import('./src/vr-optics.js');
        return new Promise(resolve=>requestAnimationFrame(()=>{
          const canvas=document.querySelector('#viewport'),gl=canvas.getContext('webgl');
          const layout=lensLayout(canvas.width,canvas.height,aeroform.inspect().optics);
          const read=(x,y)=>{const pixel=new Uint8Array(4);gl.readPixels(Math.floor(x),Math.floor(y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,pixel);return [...pixel];};
          resolve({corner:read(0,0),eyes:layout.eyes.map(e=>read(...e.center)),error:gl.getError()});
        }));
      });
      assert.equal(pixels.error,0,'WebGL reports no rendering error');assert.deepEqual(pixels.corner,[0,0,0,255]);
      for(const pixel of pixels.eyes)assert.ok(pixel[1]>180,'both alignment targets must be visible');
      await page.screenshot({path:path.join(out,name+'-lens-alignment.png')});
      await click('#alignment-btn');assert.equal((await page.evaluate(()=>aeroform.inspect())).calibrating,false);
      assert.equal(await page.locator('#lens-modal').isVisible(),true);await click('#lens-done');
      await page.keyboard.press('Escape');assert.equal((await page.evaluate(()=>aeroform.inspect())).state.vr,false);await page.reload();await page.waitForSelector('body[data-viewer="ready"]');
      assert.equal((await page.evaluate(()=>aeroform.inspect())).optics.spacing,65);
      assert.equal((await page.evaluate(()=>aeroform.inspect())).lensMode,'manual');
    });
    await check(name+' no runtime errors',async()=>assert.deepEqual(errors,[]));
    await context.close();
  }
  await check('WebGL unavailable shows an error while help remains usable',async()=>{
    const context=await browser.newContext({serviceWorkers:'block'});const page=await context.newPage();
    await page.addInitScript(()=>{const original=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl'?null:original.call(this,type,...args);};});
    await page.goto(base);await page.waitForSelector('body[data-viewer="error"]');
    assert.equal(await page.locator('#retry-btn').isVisible(),true);await page.locator('#help-btn').click();assert.equal(await page.locator('#help-modal').isVisible(),true);
    await page.locator('#close-help').click();await page.locator('#retry-btn').click();await page.waitForSelector('body[data-viewer="error"]');await context.close();
  });
  await check('offline reload and migration retain only AEROFORM-owned caches',async()=>{
    const context=await browser.newContext();const page=await context.newPage();
    // The app reloads itself once whenever a newly installed service worker takes control (caching ~17 MB with
    // MediaPipe takes a moment), so each check is retried until it runs on a settled page.
    const until=async(fn,arg,label)=>{for(let i=0;i<120;i++){try{if(await page.evaluate(fn,arg))return;}catch{}await page.waitForTimeout(500);}throw new Error('timed out: '+label);};
    const controlled=()=>Boolean(navigator.serviceWorker.controller)&&document.body.dataset.viewer==='ready';
    await page.goto(base);await until(controlled,null,'service worker control');
    await until(async()=>{await caches.open('unrelated-app');await caches.open('aeroform-v1');return true;},null,'seed caches');
    await until(async()=>{const r=await navigator.serviceWorker.getRegistration();if(r)await r.unregister();return true;},null,'unregister');
    await page.reload();await until(controlled,null,'service worker control after reload');
    await until(async()=>!(await caches.keys()).includes('aeroform-v1'),null,'old AEROFORM cache removed');
    assert.equal(await page.evaluate(async()=>(await caches.keys()).includes('unrelated-app')),true);
    await context.setOffline(true);await page.reload();await page.waitForSelector('body[data-viewer="ready"]');await page.locator('#vr-btn').click();assert.equal(await page.locator('#stereo-hud').isVisible(),true);await context.close();
  });
}catch(error){console.error(error);process.exitCode=1;}
finally {
  await browser?.close();await new Promise(resolve=>server.close(resolve));
  await writeFile(path.join(out,'browser-results.json'),JSON.stringify({testedAt:new Date().toISOString(),results,complete:results.length>0&&results.every(r=>r.status==='passed')&&process.exitCode!==1},null,2));
}
