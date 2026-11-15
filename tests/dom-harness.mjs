// Minimal DOM adapter for application-event regression tests. This is not a browser.
// Elements/attributes come from the real HTML; layout, WebGL and device APIs are simulated.
import { readFile } from 'node:fs/promises';

class Element extends EventTarget {
  constructor(tag,attributes={}) {
    super();this.tagName=tag.toUpperCase();this.attributes=attributes;this.children=[];this.dataset={};this.style={};this.value='';this.textContent='';
    this.disabled='disabled' in attributes;this.hidden='hidden' in attributes;this.open=false;
    for(const [key,value] of Object.entries(attributes))if(key.startsWith('data-'))this.dataset[key.slice(5).replace(/-([a-z])/g,(_,c)=>c.toUpperCase())]=value;
    const classes=new Set((attributes.class||'').split(/\s+/).filter(Boolean));
    this.classList={contains:c=>classes.has(c),add:c=>classes.add(c),remove:c=>classes.delete(c),toggle:(c,force)=>{const value=force??!classes.has(c);if(value)classes.add(c);else classes.delete(c);return value;}};
  }
  setAttribute(name,value){this.attributes[name]=value;}
  append(...nodes){this.children.push(...nodes);}
  replaceChildren(...nodes){this.children=nodes;}
  getAttribute(name){return this.attributes[name]??null;}
  focus(){globalThis.document.activeElement=this;}
  showModal(){this.open=true;}close(){this.open=false;}
  click(){if(!this.disabled)this.dispatchEvent(new Event('click'));}
  getBoundingClientRect(){return{left:0,top:0,right:400,bottom:400};}
  querySelector(selector){return this.querySelectorAll(selector)[0]||null;}
  querySelectorAll(selector){return this.children.flatMap(child=>[...(matches(child,selector)?[child]:[]),...child.querySelectorAll(selector)]);}
}
function matches(element,selector) {
  if(selector.includes(','))return selector.split(',').some(s=>matches(element,s));
  if(selector.includes(':not(:disabled)')){if(element.disabled)return false;selector=selector.replace(':not(:disabled)','');}
  if(selector.startsWith('#'))return element.attributes.id===selector.slice(1);
  if(selector.startsWith('.'))return element.classList.contains(selector.slice(1));
  const attrs=[...selector.matchAll(/\[([^=\]]+)(?:="?([^"\]]+)"?)?\]/g)];
  if(attrs.length)return attrs.every(([,name,value])=>name in element.attributes&&(value===undefined||element.attributes[name]===value));
  return element.tagName.toLowerCase()===selector;
}
export async function createAppHarness({graphics=true,native=false,storage=new Map(),fetch}={}) {
  const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
  const doc=new Element('document'),stack=[doc];
  for(const token of html.matchAll(/<\/?([a-z][\w-]*)([^>]*)>/gi)){
    const [whole,tag,rest]=token;
    if(whole.startsWith('</')){while(stack.length>1){const node=stack.pop();if(node.tagName===tag.toUpperCase())break;}continue;}
    const attributes={};for(const [,name,quoted,single,bare] of rest.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g))attributes[name]=quoted??single??bare??'';
    const node=new Element(tag,attributes);stack.at(-1).children.push(node);
    if(!['meta','link','input','br','img','hr'].includes(tag)&&!whole.endsWith('/>'))stack.push(node);
  }
  doc.createElement=tag=>new Element(tag);doc.visibilityState='visible';
  doc.body=doc.querySelector('body');doc.documentElement=doc.querySelector('html');doc.fullscreenElement=null;
  const win=new EventTarget();win.devicePixelRatio=1;win.isSecureContext=true;
  if(fetch)win.fetch=fetch;
  win.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value)};
  let motionRequests=0,nativeCalls=[];
  win.DeviceOrientationEvent={requestPermission:()=>{motionRequests++;return Promise.reject(new Error('Denied'));}};
  if(native)win.AeroformNative={setVrMode:enabled=>nativeCalls.push(enabled)};
  doc.documentElement.requestFullscreen=()=>Promise.reject(new Error('Fullscreen denied'));
  doc.exitFullscreen=()=>Promise.resolve();
  const canvas=doc.querySelector('#viewport');Object.assign(canvas,{clientWidth:915,clientHeight:412,width:0,height:0,setPointerCapture:()=>{}});
  const gl=new Proxy({},{get:(_,key)=>{
    if(key==='getShaderParameter'||key==='getProgramParameter')return()=>true;
    if(key==='checkFramebufferStatus')return()=>1;
    if(key.startsWith('create'))return()=>({});if(key==='getUniformLocation')return(_,name)=>name;if(key==='getAttribLocation')return()=>0;
    if(/^[A-Z_0-9]+$/.test(key))return 1;return()=>{};
  }});
  canvas.getContext=()=>graphics?gl:null;
  globalThis.document=doc;globalThis.window=win;globalThis.screen={orientation:{angle:0,lock:()=>Promise.reject(new Error('Denied')),unlock:()=>{}}};
  globalThis.requestAnimationFrame=()=>1;globalThis.cancelAnimationFrame=()=>{};
  await import('../app.js?test='+Math.random());
  for(let i=0;i<40&&!doc.body.dataset.viewer;i++)await new Promise(resolve=>setTimeout(resolve,5));
  const dispatch=(element,type,props={})=>{const event=new Event(type);Object.assign(event,props);element.dispatchEvent(event);};
  return{doc,win,canvas,find:s=>doc.querySelector(s),click:s=>doc.querySelector(s).click(),dispatch,nativeCalls,motionRequests:()=>motionRequests,settle:()=>new Promise(resolve=>setTimeout(resolve,5))};
}
