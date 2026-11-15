export const clamp = (v, low, high) => Math.min(high, Math.max(low, v));
export const radians = degrees => degrees * Math.PI / 180;
export const add = (a, b) => a.map((v, i) => v + b[i]);
export const subtract = (a, b) => a.map((v, i) => v - b[i]);
export const scale = (a, s) => a.map(v => v * s);
export const dot = (a, b) => a.reduce((sum, v, i) => sum + v * b[i], 0);
export const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
export const normalize = a => scale(a, 1 / (Math.hypot(...a) || 1));
export function perspective(fov, aspect, near = 0.08, far = 180) {
  const f = 1 / Math.tan(fov / 2), nf = 1 / (near - far);
  return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
}
export function lookAt(eye, target, up = [0, 1, 0]) {
  const z = normalize(subtract(eye, target));
  const x = normalize(cross(up, z)), y = cross(z, x);
  return new Float32Array([x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0, -dot(x,eye),-dot(y,eye),-dot(z,eye),1]);
}
export function quaternionMultiply(a, b) {
  const [ax,ay,az,aw]=a, [bx,by,bz,bw]=b;
  return [ax*bw+aw*bx+ay*bz-az*by, ay*bw+aw*by+az*bx-ax*bz, az*bw+aw*bz+ax*by-ay*bx, aw*bw-ax*bx-ay*by-az*bz];
}
export const quaternionInverse = q => [-q[0], -q[1], -q[2], q[3]];
// Interpolate on the shortest arc: q and -q describe the same orientation.
export function quaternionSlerp(a, b, amount) {
  let cosine=dot(a,b);
  if(cosine<0){b=scale(b,-1);cosine=-cosine;}
  const t=clamp(amount,0,1);
  if(cosine>.9995)return normalize(a.map((v,i)=>v+(b[i]-v)*t));
  const angle=Math.acos(clamp(cosine,-1,1)),sine=Math.sin(angle);
  return normalize(add(scale(a,Math.sin((1-t)*angle)/sine),scale(b,Math.sin(t*angle)/sine)));
}
export function rotateVector(q, v) {
  return quaternionMultiply(quaternionMultiply(q, [...v, 0]), quaternionInverse(q)).slice(0, 3);
}
export function orientationQuaternion(alpha, beta, gamma, angle = 0) {
  const [x,y,z] = [beta, alpha, -gamma].map(v => radians(v) / 2);
  const [c1,c2,c3] = [x,y,z].map(Math.cos), [s1,s2,s3] = [x,y,z].map(Math.sin);
  const euler = [s1*c2*c3+c1*s2*s3, c1*s2*c3-s1*c2*s3, c1*c2*s3-s1*s2*c3, c1*c2*c3+s1*s2*s3];
  const a = -radians(angle) / 2;
  return quaternionMultiply(quaternionMultiply(euler, [-Math.SQRT1_2,0,0,Math.SQRT1_2]), [0,0,Math.sin(a),Math.cos(a)]);
}
export function cameraBasis(yaw, pitch) {
  const forward = [Math.sin(yaw)*Math.cos(pitch), Math.sin(pitch), -Math.cos(yaw)*Math.cos(pitch)];
  const right = normalize(cross(forward, [0,1,0]));
  return { forward, right, up: cross(right, forward) };
}

// Ray against an axis-aligned box (center, full size). Returns the entry distance, or null when the
// ray misses, the box is behind, or the origin is inside the box (the camera's own room is never picked).
export function rayBox(origin, direction, center, size) {
  let near = -Infinity, far = Infinity;
  for (let axis = 0; axis < 3; axis++) {
    const low = center[axis] - size[axis] / 2, high = center[axis] + size[axis] / 2;
    if (Math.abs(direction[axis]) < 1e-12) {
      if (origin[axis] < low || origin[axis] > high) return null;
      continue;
    }
    let t1 = (low - origin[axis]) / direction[axis], t2 = (high - origin[axis]) / direction[axis];
    if (t1 > t2) [t1, t2] = [t2, t1];
    near = Math.max(near, t1); far = Math.min(far, t2);
    if (near > far) return null;
  }
  return near >= 0 ? near : null;
}
