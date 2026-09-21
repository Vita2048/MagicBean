import fs from 'node:fs';
import assert from 'node:assert/strict';
import * as Three from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

const html = fs.readFileSync(process.argv[2] || 'index.html', 'utf8');
let script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1];
script = script.replace(/  const THREE = await import\('three'\);/, '')
  .replace(/  const \{ RoomEnvironment \} =\s*await import\([^;]+;/, '')
  .replace(/  const \{ mergeVertices \} =\s*await import\([^;]+;/, '');
script = script.replace('} catch (error) {', `
  return { root, parts, centers, normals, slots, pickables, movementDefinition,
    startMove, tickMoves, reset, rotorIsChamber, traceShapes, regionField,
    get state() { return state; }, get rotation() { return rotorRotation; },
    setView(yaw, pitch) { root.quaternion.setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')); },
    constants: { GAP, ROTOR_RADIUS, D, R, TRACK_HALF, BEAN_Z } };
} catch (error) { throw error;`);
const element = () => ({ style: {}, value: '1', clientWidth: 800, clientHeight: 700,
  classList: { toggle() {} }, setAttribute() {}, appendChild() {}, addEventListener() {} });
const elements = new Map();
const document = { getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); } };
class Renderer {
  domElement = element(); shadowMap = {};
  setPixelRatio() {} setSize() {} setAnimationLoop() {} render() {}
}
const THREE = { ...Three, WebGLRenderer: Renderer, PMREMGenerator: class {
  fromScene() { return { texture: null }; } dispose() {}
} };
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
const app = await new AsyncFunction('THREE', 'mergeVertices', 'RoomEnvironment', 'document',
  'matchMedia', 'devicePixelRatio', 'ResizeObserver', 'window', script)(
  THREE, mergeVertices, class extends Three.Scene { dispose() {} }, document,
  () => ({ matches: false }), 1, class { observe() {} }, { addEventListener() {} });

// Verify actual extruded vertices, including decorations and both faces.
app.setView(0, 0);
app.root.position.set(0, 0, 0);
app.root.updateMatrixWorld(true);
const p = new Three.Vector3();
let minClearance = Infinity;
for (let lobe = 0; lobe < 3; lobe++) {
  const part = app.parts[`outer${lobe}`], n = app.normals[lobe], c = app.centers[lobe];
  for (let degrees = 0; degrees <= 360; degrees += 15) {
    part.group.quaternion.setFromAxisAngle(n, degrees * Math.PI / 180);
    app.root.updateMatrixWorld(true);
    part.group.traverse(mesh => {
      if (!mesh.isMesh) return;
      const pos = mesh.geometry.attributes.position;
      for (let i = 0; i < pos.count; i++) {
        p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        const distance = p.clone().sub(c).dot(n);
        minClearance = Math.min(minClearance, distance);
        assert(distance >= app.constants.GAP - 0.002,
          `Lobe ${lobe} ${mesh.geometry.type} (${mesh.geometry.attributes.position.count} vertices) crosses seam at ${degrees} degrees: ${distance}`);
      }
    });
  }
  part.group.quaternion.identity();
}
app.root.updateMatrixWorld(true);
app.parts.fixed.group.traverse(mesh => {
  if (!mesh.isMesh) return;
  const pos = mesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
    for (let lobe = 0; lobe < 3; lobe++) {
      const distance = p.clone().sub(app.centers[lobe]).dot(app.normals[lobe]);
      assert(distance <= -app.constants.GAP + 0.002, `Fixed mesh crosses lobe ${lobe}: ${distance}`);
    }
    assert(Math.hypot(p.x, p.y) >= app.constants.ROTOR_RADIUS + app.constants.GAP - .003,
      'Fixed mesh crosses the rotor boundary');
  }
});
console.log(`PASS: actual meshes stay on their side of all three flip seams through 360 degrees (minimum ${minClearance.toFixed(5)}).`);

for(const [name,part] of Object.entries(app.parts)) {
  let maxIntrusion=0, bad=0;
  part.group.traverse(mesh=> {
    if(!mesh.isMesh || Math.abs(mesh.position.z-.178)>.0001 || mesh.geometry.type!=='ExtrudeGeometry')return;
    const pos=mesh.geometry.attributes.position;
    for(let i=0;i<pos.count;i++) {
      p.fromBufferAttribute(pos,i).applyMatrix4(mesh.matrixWorld);
      if(p.z<.30)continue;
      const inside=Math.min(...app.centers.map(c=>Math.abs(Math.hypot(p.x-c.x,p.y-c.y)-.88)-.275));
      if(inside<-.005){bad++;maxIntrusion=Math.max(maxIntrusion,-inside);}
    }
  });
  let crossing=0;
  part.group.traverse(mesh=> {
    if(!mesh.isMesh || Math.abs(mesh.position.z-.178)>.0001 || mesh.geometry.type!=='ExtrudeGeometry')return;
    const pos=mesh.geometry.attributes.position, index=mesh.geometry.index;
    for(let j=0;j<(index?index.count:pos.count);j+=3) {
      const q=new Three.Vector3();
      for(let k=0;k<3;k++) q.add(new Three.Vector3().fromBufferAttribute(pos,index?index.getX(j+k):j+k));
      q.multiplyScalar(1/3).applyMatrix4(mesh.matrixWorld);
      if(q.z<.30)continue;
      const inside=Math.min(...app.centers.map(c=>Math.abs(Math.hypot(q.x-c.x,q.y-c.y)-.88)-.275));
      if(inside<-.02)crossing++;
    }
  });
  assert.equal(bad, 0, `${name} bevel enters a marble track by ${maxIntrusion}`);
  assert.equal(crossing, 0, `${name} triangles span a marble track`);
}
// The rotor face must contain its Y and all three moving crescents.
const rotorSolids = app.traceShapes((x,y) => Math.max(
  app.regionField('rotor', -1, x,y),
  -Math.min(...app.centers.map(c=>Math.abs(Math.hypot(x-c.x,y-c.y)-app.constants.R)-app.constants.TRACK_HALF))
) + .018);
assert.equal(rotorSolids.length,4,'Rotor must include the Y and three hub crescents');
console.log('PASS: every raised face clears the marble tracks; all three rotor crescents are present.');
const originals = app.state.slice();
let now = 0;
function move(type, extra = {}) {
  app.startMove({type, dir: 1, source: 'manual', face: 0, lobe: 0, ...extra}, now);
  now += 2000;
  app.tickMoves(now);
  now += 1;
  assert.equal(app.state.filter(Boolean).length, 60);
  assert.equal(new Set(app.state.filter(Boolean)).size, 60);
}
for (let lobe = 0; lobe < 3; lobe++) {
  move('flip', {lobe}); move('flip', {lobe});
  assert.deepEqual(app.state, originals);
}
for (let i = 0; i < 6; i++) {
  move('center');
  assert.equal(app.rotorIsChamber(), i % 2 === 0);
}
assert.deepEqual(app.state, originals);
move('center');
const chamber = app.state.slice();
move('ring'); move('ring', {dir: -1});
assert.deepEqual(app.state, chamber);
app.reset();
console.log('PASS: flips, six center turns, shared-loop circulation and inverse moves preserve all 60 marbles.');

