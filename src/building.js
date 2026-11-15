// Metres; structured geometry for future interpretation/simulation adapters.

// Thermal description of the same house, read by src/simulation. Coordinates match the boxes below:
// footprint x -6..6, z -4.5..4.5; north is -z. Zone rectangles are [x0, x1, z0, z1] and tile the footprint.
// Openings are measured along their facade (x for north/south). Connections are the interior openings and
// partitions between zones on the same floor; the stair joins the two halls.
export const THERMAL = Object.freeze({
  footprint: { x0: -6, x1: 6, z0: -4.5, z1: 4.5 },
  storeyHeight: 3.3,
  levels: [{ level: 1, floorY: 0, ground: true }, { level: 2, floorY: 3.45, roof: true }],
  zones: [
    { key: 'living', name: 'Living & kitchen', rects: [[-6, -1.6, -4.5, 4.5]] },
    { key: 'bedroom', name: 'Bedroom', rects: [[0.1, 6, -4.5, -1.3]] },
    { key: 'hall', name: 'Hall & dining', rects: [[-1.6, 6, -1.3, 4.5], [-1.6, 0.1, -4.5, -1.3]] }
  ],
  openings: [
    { facade: 'north', type: 'window', from: -5.8, to: -2.2, height: 1.7 },
    { facade: 'north', type: 'window', from: -1.8, to: 1.8, height: 1.7 },
    { facade: 'north', type: 'window', from: 2.2, to: 5.8, height: 1.7 },
    { facade: 'south', type: 'window', from: -5.95, to: -2.05, height: 2.5 },
    { facade: 'south', type: 'window', from: 2.05, to: 5.95, height: 2.5 },
    { facade: 'south', type: 'door', from: -1.95, to: -0.65, height: 2.5 }
  ],
  // area = open area between zones (m2); partitionArea = solid partition wall between them (m2).
  connections: [
    { a: 'living', b: 'hall', area: 3.45 * 3.0, partitionArea: 5.5 * 3.0, at: [-1.6, 2.8] },
    { a: 'bedroom', b: 'hall', area: 1.3 * 2.6, partitionArea: 4.1 * 3.0, at: [4.9, -1.3] }
  ],
  // at = doorway centre [x, z]; the stair climbs from bottom [x, z] on floor 1 to top [x, z] on floor 2.
  stair: { zone: 'hall', area: 1.5 * 3.4, bottom: [4.7, 3.9], top: [4.7, 0.5] }
});
export function createBuilding() {
  const boxes = [];
  const colors = { plaster:'#dddccc', wood:'#95704e', dark:'#30413b', glass:'#91d3c9', metal:'#aab9b1', fabric:'#d5d0b9', green:'#44684c' };
  const box = (name, center, size, color, floor = 0, extra = {}) => boxes.push({ name, center, size, color: colors[color] || color, floor, ...extra });
  box('site', [0,-.38,0], [26,.35,22], '#193d30');
  box('foundation', [0,-.16,0], [13.2,.22,10.2], '#82958a');
  box('entry path', [0,-.13,8], [2.5,.15,7], '#738b7c');
  for (const x of [-9,9]) for (const z of [-7,6]) {
    box('planter', [x,.1,z], [1.6,.4,1.6], 'dark');
    box('trunk', [x,1,z], [.18,1.7,.18], 'wood');
    box('tree canopy', [x,2,z], [1.5,1.5,1.5], 'green');
    box('tree crown', [x,2.8,z], [1,1,1], '#5d8158');
  }
  const rooms = [];
  for (const level of [1,2]) {
    const y = (level-1)*3.45;
    const b = (name,p,s,c,extra={}) => box(name,[p[0],p[1]+y,p[2]],s,c,level,extra);
    b('floor',[0,-.08,0],[12,.16,9],'wood');
    b('west wall',[-6,1.65,0],[.16,3.3,9],'plaster');
    b('east wall',[6,1.65,0],[.16,3.3,9],'plaster',{cutaway:true});
    b('north sill',[0,.5,-4.5],[12,1,.16],'plaster');
    b('north lintel',[0,3,-4.5],[12,.6,.16],'plaster');
    for (const x of [-5.85,-2,2,5.85]) b('window pier',[x,1.85,-4.5],[.3,1.7,.16],'plaster');
    for (const x of [-4,0,4]) {
      b('north window',[x,1.85,-4.5],[3.6,1.7,.045],'glass',{transparent:true});
      b('window frame',[x,1.85,-4.47],[.055,1.7,.09],'dark');
    }
    for (const x of [-4,4]) {
      b('south sill',[x,.3,4.5],[3.9,.6,.18],'plaster',{cutaway:true});
      b('south glazing',[x,1.85,4.5],[3.9,2.5,.045],'glass',{transparent:true,cutaway:true});
    }
    b('entry lintel',[0,3.05,4.5],[4.2,.5,.2],'plaster',{cutaway:true});
    b('door',[-1.3,1.25,4.5],[1.3,2.5,.09],'wood',{cutaway:true});
    b('door handle',[-.85,1.2,4.6],[.07,.3,.08],'metal',{cutaway:true});
    b('living partition',[-1.6,1.5,-1.7],[.12,3,5.5],'plaster');
    b('bedroom partition',[2.2,1.5,-1.3],[4.1,3,.12],'plaster');
    b('bedroom doorway lintel',[4.9,2.8,-1.3],[1.3,.4,.12],'plaster');
    b('sofa base',[-3.8,.36,1.8],[2.6,.5,1.1],'dark');
    b('sofa seat',[-3.8,.7,1.8],[2.6,.22,1.1],'fabric');
    b('sofa back',[-3.8,1,2.3],[2.6,.7,.22],'fabric');
    for (const x of [-4.85,-2.75]) b('sofa arm',[x,.87,1.8],[.3,.6,1.2],'fabric');
    b('rug',[-3.8,.015,.15],[3.1,.02,1.7],'#82958a');
    b('coffee table',[-3.8,.4,.15],[1.5,.12,.7],'wood');
    for (const x of [-4.35,-3.25]) b('table leg',[x,.2,.15],[.12,.4,.5],'dark');
    b('dining table',[1.05,.85,1.8],[1.65,.12,1.1],'wood');
    b('table pedestal',[1.05,.4,1.8],[.3,.8,.5],'dark');
    for (const z of [.8,2.8]) {
      b('chair seat',[1.05,.5,z],[.6,.12,.55],'dark');
      b('chair back',[1.05,.85,z+(z>2?.25:-.25)],[.6,.6,.1],'dark');
      b('chair support',[1.05,.25,z],[.35,.5,.35],'wood');
    }
    b('bed frame',[3.8,.3,-3],[2.7,.45,1.9],'wood');
    b('mattress',[3.8,.65,-3],[2.6,.3,1.8],'fabric');
    b('duvet',[4.05,.83,-3],[1.9,.1,1.8],'#718b7e');
    b('pillow',[2.85,.88,-3],[.5,.15,1.4],'plaster');
    // Movable HVAC: every box in a group moves together when grabbed (see viewer grab).
    b('HVAC vent',[0,3.1,-.8],[1.1,.08,.5],'metal',{type:'vent',group:`vent-${level}`,movable:true});
    for (let i=0;i<6;i++) b('vent grille',[-.42+i*.16,3.04,-.8],[.045,.03,.42],'dark',{group:`vent-${level}`,movable:true});
    // Demo starting layout, deliberately poor: each floor's AC unit is in the small bedroom (19 m2), so the hall
    // and living rooms (90 m2) are left too hot or too cold. Analysis -> Find improvements finds the better spot
    // ("Move the floor 1 AC unit into the hall & dining"). The vents in the hall are fine where they are.
    b('AC unit',[5.76,2.4,-2.9],[.3,.6,1.2],'metal',{type:'ac',group:`ac-${level}`,movable:true});
    b('kitchen counter',[-4.5,.5,-3.6],[2.5,1,.85],'dark');
    b('countertop',[-4.5,1.04,-3.6],[2.6,.08,.9],'plaster');
    for (const zone of THERMAL.zones) rooms.push({id:`${zone.key}-${level}`,level,name:zone.name,bounds:zone.rects[0],rects:zone.rects});
  }
  for (let i=0;i<12;i++) box('stair tread',[4.7,.12+i*.287,3.8-i*.29],[1.5,.14,.32],'wood',1);
  box('roof',[0,6.9,0],[12.5,.2,9.5],'#405c4f',0,{roof:true});
  box('solar panels',[-2,7.05,-.5],[5,.08,5],'#263d4e',0,{roof:true});
  // home = designed position, so moved items can be reset.
  boxes.forEach((item, index) => { item.id = index; item.home = [...item.center]; });
  return {schemaVersion:2,id:'atrium-house',units:'m',boxes,rooms,thermal:THERMAL,source:{kind:'procedural-demo',interpretedByAI:false}};
}
export function isVisible(item, state) {
  if (item.roof) return state.view === 'exterior' && state.floor === 'all' && !state.vr;
  if (item.floor && state.floor !== 'all' && item.floor !== Number(state.floor)) return false;
  if (item.cutaway && state.view === 'interior' && !state.vr) return false;
  return true;
}
