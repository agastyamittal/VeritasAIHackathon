import { clamp } from './math.js';

// S24+ full-rectangle display: 169.1 mm diagonal, 3120:1440 aspect.
// Gear VR R324 specification: fixed 62 mm lens spacing. This is also the
// starting profile for the user's black R323/R324/R325 family, not eye tracking.
export const SCREEN_WIDTH_MM=169.1*3120/Math.hypot(3120,1440);
export const SCREEN_HEIGHT_MM=169.1*1440/Math.hypot(3120,1440);
export const GEAR_VR_SPACING_MM=62;
export const DEFAULT_OPTICS=Object.freeze({spacing:62,size:94,height:0,fov:90,distortion:22,depth:100});
const limits={spacing:[55,72],size:[75,100],height:[-6,6],fov:[70,105],distortion:[0,50],depth:[0,100]};
export function normalizeOptics(values={}) {
  return Object.fromEntries(Object.entries(DEFAULT_OPTICS).map(([key,value])=>[key,
    Number.isFinite(values?.[key])?clamp(values[key],...limits[key]):value]));
}
export function calculateAutomaticFit() {
  const spacing=GEAR_VR_SPACING_MM;
  // Centered phone: lens centers are +/- half the inter-lens distance.
  const centerMm=[(SCREEN_WIDTH_MM-spacing)/2,(SCREEN_WIDTH_MM+spacing)/2];
  // Fit circles inside each half with 1 mm inner/outer and 3 mm vertical margins.
  // These are layout margins, not a measurement of the lens aperture or focal length.
  const availableDiameter=Math.min(SCREEN_HEIGHT_MM,spacing,SCREEN_WIDTH_MM-spacing);
  const diameterMm=Math.min(SCREEN_HEIGHT_MM-6,spacing-2,SCREEN_WIDTH_MM-spacing-2);
  return {
    optics:normalizeOptics({...DEFAULT_OPTICS,spacing,size:100*diameterMm/availableDiameter,height:0}),
    screenMm:[SCREEN_WIDTH_MM,SCREEN_HEIGHT_MM],centerMm,
    centerPercent:centerMm.map(x=>100*x/SCREEN_WIDTH_MM),diameterMm
  };
}
export function normalizeLensFit(value) {
  return {mode:value?.mode==='manual'?'manual':'auto',
    manual:normalizeOptics(value?.manual&&typeof value.manual==='object'?value.manual:calculateAutomaticFit().optics)};
}
export function lensLayout(width,height,values=DEFAULT_OPTICS) {
  const w=Math.max(2,Math.floor(width)),h=Math.max(1,Math.floor(height)),o=normalizeOptics(values);
  const pixelsPerMm=Math.max(w,h)/SCREEN_WIDTH_MM;
  // Portrait is a preview only; keep both circles inside their own screen halves.
  const separation=Math.min(w*.49,o.spacing*pixelsPerMm);
  const diameter=Math.max(1,Math.floor(Math.min(h,separation,w-separation)*o.size/100));
  const y=clamp(h/2-o.height*pixelsPerMm,diameter/2,h-diameter/2);
  const eyes=[-1,1].map(sign=>{
    const x=w/2+sign*separation/2;
    return {center:[x,y],rect:[Math.round(x-diameter/2),Math.round(y-diameter/2),diameter,diameter],offset:sign*.032*o.depth/100};
  });
  return {width:w,height:h,diameter,separation,eyes};
}

// Screen coordinates about a lens center -> undistorted source texture.
// Normalizing by (1+k) keeps the entire circular aperture inside that eye's texture.
export function lensSample(x,y,distortion=DEFAULT_OPTICS.distortion) {
  const r2=x*x+y*y;if(r2>1)return null;
  const k=clamp(distortion,0,50)/100,factor=(1+k*r2)/(1+k);
  return [.5+.5*x*factor,.5+.5*y*factor];
}

const vertex=`attribute vec2 aCorner; varying mediump vec2 vLens;
void main(){vLens=aCorner;gl_Position=vec4(aCorner,0.0,1.0);}`;
const fragment=`precision mediump float;
uniform sampler2D uEye; uniform float uDistortion; uniform float uCalibration;
varying mediump vec2 vLens;
void main(){
  float r2=dot(vLens,vLens);
  if(r2>1.0){gl_FragColor=vec4(0.0,0.0,0.0,1.0);return;}
  vec2 warped=vLens*(1.0+uDistortion*r2)/(1.0+uDistortion);
  vec3 color=texture2D(uEye,0.5+0.5*warped).rgb;
  if(uCalibration>0.5){
    vec2 grid=abs(fract(warped*4.0+0.5)-0.5);
    float line=1.0-step(0.018,min(grid.x,grid.y));
    color=mix(vec3(0.015,0.025,0.025),vec3(0.22,0.3,0.3),line);
    float crosshair=(1.0-step(0.009,min(abs(warped.x),abs(warped.y))))*(1.0-step(0.12,max(abs(warped.x),abs(warped.y))));
    float ring=1.0-step(0.006,abs(length(warped)-0.09));
    color=mix(color,vec3(0.72,0.96,0.43),max(crosshair,ring));
  }
  gl_FragColor=vec4(color*(1.0-smoothstep(0.97,1.0,r2)),1.0);
}`;

// Render each eye to its own reusable square texture, then apply radial correction.
export function createLensRenderer(gl) {
  const shaders=[];
  function compile(type,source){
    const s=gl.createShader(type);shaders.push(s);gl.shaderSource(s,source);gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error('Lens shader: '+gl.getShaderInfoLog(s));
    return s;
  }
  const program=gl.createProgram();
  gl.attachShader(program,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fragment));gl.bindAttribLocation(program,0,'aCorner');gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error('Lens program: '+gl.getProgramInfoLog(program));
  shaders.forEach(s=>gl.deleteShader(s));
  const corner=gl.getAttribLocation(program,'aCorner');
  const uniforms=Object.fromEntries(['Eye','Distortion','Calibration'].map(n=>[n,gl.getUniformLocation(program,'u'+n)]));
  const quad=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,quad);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
  const texture=gl.createTexture(),depth=gl.createRenderbuffer(),framebuffer=gl.createFramebuffer();let size=0;
  return {
    begin(diameter){
      const next=Math.max(1,Math.min(1024,diameter));
      gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);
      if(size!==next){
        gl.bindTexture(gl.TEXTURE_2D,texture);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
        gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,next,next,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
        gl.bindRenderbuffer(gl.RENDERBUFFER,depth);gl.renderbufferStorage(gl.RENDERBUFFER,gl.DEPTH_COMPONENT16,next,next);
        gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER,gl.DEPTH_ATTACHMENT,gl.RENDERBUFFER,depth);
        if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE){gl.bindFramebuffer(gl.FRAMEBUFFER,null);throw new Error('Lens rendering is unavailable on this device.');}
        size=next;
      }
      // Never sample a texture while it is also the active render target.
      gl.bindTexture(gl.TEXTURE_2D,null);gl.enable(gl.DEPTH_TEST);gl.enable(gl.BLEND);gl.depthMask(true);
      gl.disable(gl.SCISSOR_TEST);gl.clearColor(.047,.047,.047,1);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.SCISSOR_TEST);
      return [0,0,size,size];
    },
    present(rect,settings,calibrating){
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.useProgram(program);gl.disable(gl.DEPTH_TEST);gl.disable(gl.BLEND);
      gl.viewport(...rect);gl.scissor(...rect);
      gl.bindBuffer(gl.ARRAY_BUFFER,quad);gl.enableVertexAttribArray(corner);gl.vertexAttribPointer(corner,2,gl.FLOAT,false,0,0);
      // Attribute pointers persist across programs; disable the scene's other attributes.
      for(const location of [0,1])if(location!==corner)gl.disableVertexAttribArray(location);
      gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
      gl.uniform1i(uniforms.Eye,0);gl.uniform1f(uniforms.Distortion,settings.distortion/100);gl.uniform1f(uniforms.Calibration,calibrating?1:0);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    },
    dispose(){gl.deleteFramebuffer(framebuffer);gl.deleteRenderbuffer(depth);gl.deleteTexture(texture);gl.deleteBuffer(quad);gl.deleteProgram(program);}
  };
}
