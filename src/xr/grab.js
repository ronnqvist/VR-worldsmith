/**
 * Grabbing `.interactive` entities of the generated world.
 *
 *  VR (ws-grab on the right controller, which carries laser-controls):
 *    trigger on an .interactive entity → grab; it rigidly follows the controller
 *    right thumbstick Y while holding → push / pull along the ray
 *    grip ("squeeze") while holding → delete (the app shows a 3 s undo toast)
 *    trigger release → drop; the new transform is committed (undoable)
 *  Desktop (ws-mouse-grab on the scene, which carries the mouse cursor):
 *    mouse down on .interactive → drag at constant distance along the mouse ray
 *    mouse wheel → push / pull, Delete/Backspace → delete, mouse up → drop
 *
 * Only entities inside #generated-world can be grabbed; app UI never can.
 * Results go out as bus events (`world:transform`, `world:delete`) so the
 * injector stays the single writer of world state.
 */
import AFRAME from 'aframe';
import { bus } from '../core/bus.js';

const THREE = AFRAME.THREE;
const tmpMat = new THREE.Matrix4();
const tmpInv = new THREE.Matrix4();
const tmpPos = new THREE.Vector3();
const tmpQuat = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpEuler = new THREE.Euler();
const tmpScratch = new THREE.Vector3();

function grabbableFrom(el) {
  const target = el?.closest?.('.interactive');
  if (!target || !target.id) return null;
  if (!target.closest('#generated-world')) return null;
  return target;
}

function pauseAnimations(el, pause) {
  for (const [name, comp] of Object.entries(el.components || {})) {
    if (name.startsWith('animation')) pause ? comp.pause() : comp.play();
  }
}

/** Writes a world matrix into an object's local transform (relative to its parent). */
function setWorldMatrix(obj, worldMatrix) {
  obj.parent.updateMatrixWorld(true);
  tmpInv.copy(obj.parent.matrixWorld).invert();
  tmpMat.multiplyMatrices(tmpInv, worldMatrix);
  tmpMat.decompose(obj.position, obj.quaternion, tmpScale);
}

function emitCommit(target) {
  const o = target.object3D;
  tmpEuler.setFromQuaternion(o.quaternion, 'YXZ');
  const toDeg = THREE.MathUtils.radToDeg;
  bus.emit('world:transform', {
    id: target.id,
    position: { x: o.position.x, y: o.position.y, z: o.position.z },
    rotation: { x: toDeg(tmpEuler.x), y: toDeg(tmpEuler.y), z: toDeg(tmpEuler.z) }
  });
}

AFRAME.registerComponent('ws-grab', {
  schema: { rig: { type: 'selector', default: '#rig' } },

  init() {
    this.target = null;
    this.offset = new THREE.Matrix4();
    this.pushAxis = 0;
    this.onTriggerDown = () => this.tryGrab();
    this.onTriggerUp = () => this.release(true);
    this.onGripDown = () => this.deleteHeld();
    this.onStick = (e) => { this.pushAxis = Math.abs(e.detail.y) > 0.25 ? e.detail.y : 0; };
  },

  play() {
    this.el.addEventListener('triggerdown', this.onTriggerDown);
    this.el.addEventListener('triggerup', this.onTriggerUp);
    this.el.addEventListener('gripdown', this.onGripDown);
    this.el.addEventListener('thumbstickmoved', this.onStick);
  },

  pause() {
    this.release(true);
    this.el.removeEventListener('triggerdown', this.onTriggerDown);
    this.el.removeEventListener('triggerup', this.onTriggerUp);
    this.el.removeEventListener('gripdown', this.onGripDown);
    this.el.removeEventListener('thumbstickmoved', this.onStick);
  },

  tryGrab() {
    const rc = this.el.components.raycaster;
    if (!rc || this.target) return;
    for (const hitEl of rc.intersectedEls) {
      if (hitEl.classList.contains('ws-clickable')) return; // UI in front wins
      const target = grabbableFrom(hitEl);
      if (!target) continue;
      this.target = target;
      this.el.object3D.updateMatrixWorld(true);
      target.object3D.updateMatrixWorld(true);
      // offset = inverse(controller) * target  → target follows the controller rigidly.
      this.offset.copy(this.el.object3D.matrixWorld).invert().multiply(target.object3D.matrixWorld);
      pauseAnimations(target, true);
      this.setTurnSuspended(true);
      target.emit('grab-start', { hand: 'right' }, false);
      bus.emit('grab:start', { id: target.id });
      return;
    }
  },

  setTurnSuspended(on) {
    const loco = this.data.rig?.components['ws-locomotion'];
    if (loco) loco.suspendTurn = on;
  },

  tick(t, dt) {
    if (!this.target) return;
    if (!this.target.isConnected) { this.release(false); return; }
    if (this.pushAxis && dt) {
      // Push/pull along the controller's local -Z.
      const d = -this.pushAxis * 2.5 * (dt / 1000);
      tmpMat.makeTranslation(0, 0, -d);
      this.offset.premultiply(tmpMat);
    }
    this.el.object3D.updateMatrixWorld(true);
    tmpMat.multiplyMatrices(this.el.object3D.matrixWorld, this.offset);
    setWorldMatrix(this.target.object3D, tmpMat);
  },

  release(commit) {
    const target = this.target;
    if (!target) return;
    this.target = null;
    this.pushAxis = 0;
    this.setTurnSuspended(false);
    if (target.isConnected) {
      target.emit('grab-end', { hand: 'right' }, false);
      if (commit) emitCommit(target);
      pauseAnimations(target, false);
    }
    bus.emit('grab:end', {});
  },

  deleteHeld() {
    const target = this.target;
    if (!target) return;
    this.release(false);
    bus.emit('world:delete', { id: target.id });
  }
});

/** Desktop mouse dragging (attached to <a-scene>, which has cursor="rayOrigin: mouse"). */
AFRAME.registerComponent('ws-mouse-grab', {
  init() {
    this.target = null;
    this.distance = 2;
    this.localOffset = new THREE.Vector3();
    this.onMouseDown = (e) => this.begin(e);
    this.onMouseUp = () => this.end(true);
    this.onWheel = (e) => {
      if (!this.target) return;
      e.preventDefault();
      this.distance = Math.max(0.3, Math.min(60, this.distance * (e.deltaY > 0 ? 0.92 : 1.08)));
    };
    this.onKey = (e) => {
      if (!this.target) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        const id = this.target.id;
        this.end(false);
        bus.emit('world:delete', { id });
      } else if (e.key === 'Escape') {
        this.end(false);
      }
    };
  },
  play() {
    this.el.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('keydown', this.onKey);
  },
  pause() {
    this.el.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('keydown', this.onKey);
  },
  rayInfo() {
    const rc = this.el.components.raycaster;
    if (!rc) return null;
    return { origin: rc.raycaster.ray.origin, direction: rc.raycaster.ray.direction };
  },
  begin(e) {
    // Only mouse-cursor events (laser events carry a cursorEl that isn't the scene).
    if (e.detail?.cursorEl && e.detail.cursorEl !== this.el) return;
    if (this.el.is('vr-mode') || this.el.is('ar-mode')) return;
    const hit = e.detail?.intersection;
    const target = grabbableFrom(e.target);
    if (!target || !hit) return;
    this.target = target;
    this.distance = hit.distance;
    target.object3D.getWorldPosition(tmpPos);
    this.localOffset.copy(tmpPos).sub(hit.point);
    // Stop look-controls from rotating the view while dragging.
    const cam = this.el.camera?.el;
    cam?.setAttribute('look-controls', 'enabled', false);
    pauseAnimations(target, true);
    target.emit('grab-start', { hand: 'mouse' }, false);
    bus.emit('grab:start', { id: target.id, desktop: true });
  },
  tick() {
    if (!this.target) return;
    if (!this.target.isConnected) { this.end(false); return; }
    const ray = this.rayInfo();
    if (!ray) return;
    const o = this.target.object3D;
    tmpPos.copy(ray.origin).addScaledVector(ray.direction, this.distance).add(this.localOffset);
    o.updateMatrixWorld(true);
    o.matrixWorld.decompose(tmpScratch, tmpQuat, tmpScale); // keep world rotation + scale
    tmpMat.compose(tmpPos, tmpQuat, tmpScale);
    setWorldMatrix(o, tmpMat);
  },
  end(commit) {
    const target = this.target;
    if (!target) return;
    this.target = null;
    this.el.camera?.el?.setAttribute('look-controls', 'enabled', true);
    if (target.isConnected) {
      target.emit('grab-end', { hand: 'mouse' }, false);
      if (commit) emitCommit(target);
      pauseAnimations(target, false);
    }
    bus.emit('grab:end', {});
  }
});
