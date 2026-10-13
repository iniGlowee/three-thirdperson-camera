/**
 * three-thirdperson-camera — a drop-in orbit/follow camera for three.js.
 *
 * Orbits a target with mouse-drag (or pointer-lock) look and scroll-wheel zoom,
 * eases its position behind the target with a damped chase, and — optionally —
 * pulls its boom in when a wall comes between the camera and the character so the
 * view never clips through geometry. Also carries the two small view tweaks a
 * third-person game usually wants: a tight near/far clip range (depth precision
 * for dense, coplanar scenery) and distance fog that dissolves the far plane into
 * the sky.
 *
 * It drives a THREE.PerspectiveCamera you own; it never creates a renderer, a
 * scene, or a loop. Call `update(dt)` once per frame before you render.
 *
 *   import * as THREE from 'three';
 *   import { ThirdPersonCamera } from './three-thirdperson-camera.js';
 *
 *   const cam = new THREE.PerspectiveCamera(50, aspect, 0.1, 1000);
 *   const rig = new ThirdPersonCamera({
 *     camera: cam,
 *     domElement: renderer.domElement,
 *     target: playerObject3D,            // anything with a .position (or .getWorldPosition)
 *     colliders: () => scene.children,   // optional — enables boom collision
 *   });
 *   // each frame:
 *   rig.update(dt);
 *   renderer.render(scene, cam);
 *
 * Occluder fade (dithering out geometry between the lens and the character, as an
 * alternative to the hard boom pull-in) is a separate concern and ships as its own
 * module — see https://github.com/iniGlowee/occluder-dither-fade. This camera
 * exposes `distance` each frame so that effect can tune its fade band to the boom.
 *
 * No dependencies beyond three.js (passed in). MIT.
 */

const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

const DEFAULTS = {
  // framing
  distance: 4,         // starting boom length (metres)
  lookHeight: 1.6,     // the pivot sits this far above the target origin (head height)
  shoulder: 0,         // slide the pivot along the camera's right for off-centre framing
  minPitch: -60,       // degrees; clamp so the orbit can't flip under the floor …
  maxPitch: 75,        // … or over the top
  startPitch: 12,      // degrees above the pivot, looking slightly down

  // look input
  sensitivity: 0.15,   // degrees of orbit per pixel of pointer motion
  invertY: false,
  pointerLock: false,  // true = lock the pointer and look always; false = drag to look
  dragButton: 2,       // which mouse button drags the look when pointerLock is off (2 = right)
  keyLook: false,      // arrow keys also orbit (handy for a cursor-visible point-and-click)
  keyLookSpeed: 120,   // degrees/second for arrow-key orbit
  lookSmooth: 0,       // seconds of "mass" on the look (0 = raw/instant; ~0.07 = a touch of glide)

  // zoom
  wheelZoom: true,
  zoomMin: 1.5,
  zoomMax: 24,
  zoomStep: 1.2,       // metres per wheel notch

  // chase
  chaseLag: 0.08,      // seconds of position damping (0 = rigidly glued to the ideal spot)
  snapDistance: 4,     // if the ideal spot jumps further than this, snap (teleport/scene change)

  // collision (needs `colliders`)
  collide: false,      // pull the boom in when the view is blocked
  collideMargin: 0.3,  // keep the camera this far off the wall it hit
  collideMin: 0.6,     // never pull closer than this

  // projection extras
  nearPlane: 0,        // >0 overrides camera.near (tight far plane fixes z-fighting on stacked geometry)
  farPlane: 0,         // >0 overrides camera.far
  fov: 0,              // >0 overrides camera.fov

  // fog (applied to a scene you pass to applyFog)
  fog: false,
  fogColor: 0x8899aa,
  fogStart: 0.5,       // fraction of farPlane where fog begins
  fogSky: true,        // paint scene.background the fog colour (no hard horizon)
};

export class ThirdPersonCamera {
  /**
   * @param {object} opts
   * @param {THREE.PerspectiveCamera} opts.camera  the camera to drive (required)
   * @param {object} opts.THREE                    the three.js module (required — pass your `import * as THREE`)
   * @param {HTMLElement} [opts.domElement]        element to bind look/zoom input to (required for input)
   * @param {THREE.Object3D|{position}} [opts.target]  what to orbit
   * @param {Function} [opts.colliders]            () => Object3D[] to raycast for boom collision
   * plus any of the DEFAULTS above.
   */
  constructor(opts = {}) {
    const THREE = opts.THREE || opts.three;
    if (!THREE) throw new Error('[ThirdPersonCamera] pass the three.js module as opts.THREE');
    if (!opts.camera) throw new Error('[ThirdPersonCamera] opts.camera (a PerspectiveCamera) is required');
    this.THREE = THREE;
    this.camera = opts.camera;
    this.domElement = opts.domElement || null;
    this.target = opts.target || null;
    this.colliders = typeof opts.colliders === 'function' ? opts.colliders : null;

    const o = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS)) if (opts[k] !== undefined) o[k] = opts[k];
    this.options = o;

    // orbit state (the "where", separate from the tunable "feel" in options)
    this.yaw = 0;              // degrees, azimuth around the target
    this.pitch = o.startPitch; // degrees
    this.distance = o.distance;

    this._zoom = o.distance;
    this._placed = false;      // has the camera been snapped to a valid spot yet?
    this._lookVy = 0;
    this._lookVp = 0;
    this._wheel = 0;           // accumulated wheel notches, drained each update
    this._lookDx = 0;          // accumulated pointer look deltas, drained each update
    this._lookDy = 0;
    this._dragging = false;
    this._keys = Object.create(null);
    this._locked = false;

    // scratch vectors
    this._ray = new THREE.Raycaster();
    this._ray.layers.enableAll();
    this._v = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._fog = null;

    this._bind();
    this._applyProjection();
    this.faceTargetHeading();
  }

  /* -- input binding ----------------------------------------------------- */

  _bind() {
    const el = this.domElement;
    if (!el) return;
    const o = this.options;

    this._onMove = (e) => {
      if (this._locked) {
        this._lookDx += e.movementX || 0;
        this._lookDy += e.movementY || 0;
      } else if (this._dragging) {
        this._lookDx += e.movementX || 0;
        this._lookDy += e.movementY || 0;
      }
    };
    this._onDown = (e) => {
      if (o.pointerLock) { el.requestPointerLock?.(); return; }
      if (e.button === o.dragButton) { this._dragging = true; e.preventDefault(); }
    };
    this._onUp = (e) => { if (e.button === o.dragButton) this._dragging = false; };
    this._onWheel = (e) => {
      if (!o.wheelZoom) return;
      this._wheel += Math.sign(e.deltaY);
      e.preventDefault();
    };
    this._onCtx = (e) => { if (o.dragButton === 2) e.preventDefault(); }; // keep right-drag from popping the browser menu
    this._onLock = () => { this._locked = document.pointerLockElement === el; };
    this._onKeyDown = (e) => { this._keys[e.code] = true; };
    this._onKeyUp = (e) => { this._keys[e.code] = false; };

    el.addEventListener('mousemove', this._onMove);
    el.addEventListener('mousedown', this._onDown);
    window.addEventListener('mouseup', this._onUp);
    el.addEventListener('wheel', this._onWheel, { passive: false });
    el.addEventListener('contextmenu', this._onCtx);
    document.addEventListener('pointerlockchange', this._onLock);
    if (o.keyLook) {
      window.addEventListener('keydown', this._onKeyDown);
      window.addEventListener('keyup', this._onKeyUp);
    }
  }

  dispose() {
    const el = this.domElement;
    if (el) {
      el.removeEventListener('mousemove', this._onMove);
      el.removeEventListener('mousedown', this._onDown);
      window.removeEventListener('mouseup', this._onUp);
      el.removeEventListener('wheel', this._onWheel);
      el.removeEventListener('contextmenu', this._onCtx);
      document.removeEventListener('pointerlockchange', this._onLock);
      window.removeEventListener('keydown', this._onKeyDown);
      window.removeEventListener('keyup', this._onKeyUp);
    }
  }

  /* -- public API -------------------------------------------------------- */

  setTarget(t) { this.target = t; }

  /** Set the orbit so it opens behind the target's current facing (yaw about Y). */
  faceTargetHeading() {
    const t = this.target;
    if (!t) return;
    const h = (t.heading != null ? t.heading
      : t.rotation ? t.rotation.y / DEG : 0);
    this.yaw = ((h + 180) % 360 + 360) % 360;
  }

  _targetPos(out) {
    const t = this.target;
    if (!t) return out.set(0, 0, 0);
    if (typeof t.getWorldPosition === 'function') return t.getWorldPosition(out);
    if (t.position) return out.copy(t.position);
    return out.set(t.x || 0, t.y || 0, t.z || 0);
  }

  /** Call once per frame (seconds since last frame) before rendering. */
  update(dt) {
    dt = Math.max(0, Math.min(0.1, dt || 0));
    const o = this.options;
    const cam = this.camera;
    const THREE = this.THREE;

    // 1) look — drain pointer deltas (and arrow keys) into yaw/pitch
    let wantYaw = -this._lookDx * o.sensitivity;
    let wantPitch = this._lookDy * o.sensitivity * (o.invertY ? -1 : 1);
    this._lookDx = 0; this._lookDy = 0;
    if (o.keyLook) {
      const kr = o.keyLookSpeed * dt;
      if (this._keys.ArrowLeft) wantYaw += kr;
      if (this._keys.ArrowRight) wantYaw -= kr;
      if (this._keys.ArrowUp) wantPitch -= kr;
      if (this._keys.ArrowDown) wantPitch += kr;
    }
    const sm = Math.max(0, o.lookSmooth);
    if (sm > 0 && dt > 0) {
      // a little mass: accelerate the look in, glide it out over `lookSmooth`
      const k = Math.min(1, dt / sm);
      this._lookVy += (wantYaw / dt - this._lookVy) * k;
      this._lookVp += (wantPitch / dt - this._lookVp) * k;
      this.yaw += this._lookVy * dt;
      this.pitch += this._lookVp * dt;
    } else {
      this.yaw += wantYaw;
      this.pitch += wantPitch;
    }
    this.pitch = clamp(this.pitch, o.minPitch, o.maxPitch);

    // 2) zoom — drain wheel notches into the boom distance
    if (o.wheelZoom && this._wheel) {
      this._zoom = clamp(this._zoom + this._wheel * o.zoomStep, o.zoomMin, o.zoomMax);
      this._wheel = 0;
    }
    const boom = o.wheelZoom ? this._zoom : o.distance;
    this.distance = boom;

    // 3) the pivot (look point): target origin + head height, optional shoulder offset
    const yaw = this.yaw * DEG, pitch = this.pitch * DEG;
    this._targetPos(this._look);
    this._look.y += o.lookHeight;
    if (o.shoulder) {
      this._look.x += Math.cos(yaw) * o.shoulder;
      this._look.z += -Math.sin(yaw) * o.shoulder;
    }

    // 4) spherical offset behind the pivot → the ideal camera spot
    this._dir.set(Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch));
    let d = boom;

    // 5) collision — cast pivot→ideal, pull the boom in to the first hit
    if (o.collide && this.colliders) {
      const from = this._look;
      this._v.copy(this._dir).multiplyScalar(d).add(from); // ideal spot
      const len = this._v.distanceTo(from);
      if (len > 1e-4) {
        this._ray.set(from, this._v.sub(from).multiplyScalar(1 / len));
        this._ray.far = len;
        const hits = this._ray.intersectObjects(this._collideList(), true);
        const hit = this._firstHit(hits);
        if (hit) d = Math.max(o.collideMin, hit.distance - o.collideMargin);
      }
    }

    const ix = this._look.x + this._dir.x * d;
    const iy = this._look.y + this._dir.y * d;
    const iz = this._look.z + this._dir.z * d;

    // 6) damped chase toward the ideal spot (snap on a big jump)
    const far = Math.hypot(ix - cam.position.x, iy - cam.position.y, iz - cam.position.z);
    if (!this._placed || far > o.snapDistance) {
      cam.position.set(ix, iy, iz);
      this._placed = true;
    } else if (o.chaseLag > 0) {
      const k = Math.min(1, dt / Math.max(0.01, o.chaseLag));
      const kY = Math.min(1, dt / Math.max(0.01, o.chaseLag * 1.6)); // Y heavier — the camera floats, doesn't bounce
      cam.position.x += (ix - cam.position.x) * k;
      cam.position.z += (iz - cam.position.z) * k;
      cam.position.y += (iy - cam.position.y) * kY;
    } else {
      cam.position.set(ix, iy, iz);
    }

    // 7) aim: look back at the pivot (YXZ euler = yaw about Y, then pitch about X)
    cam.up.set(0, 1, 0);
    cam.lookAt(this._look.x, this._look.y, this._look.z);
  }

  _collideList() {
    const c = this.colliders ? this.colliders() : [];
    return Array.isArray(c) ? c : [c];
  }

  _firstHit(hits) {
    const t = this.target;
    const tObj = (t && t.isObject3D) ? t : null;
    for (const h of hits) {
      if (tObj) { // skip the character's own body (the ray starts inside it)
        let o = h.object, self = false;
        while (o) { if (o === tObj) { self = true; break; } o = o.parent; }
        if (self) continue;
      }
      if (h.object && h.object.userData && h.object.userData.cameraTransparent) continue;
      return h;
    }
    return null;
  }

  /* -- projection + fog -------------------------------------------------- */

  _applyProjection() {
    const o = this.options, cam = this.camera;
    let changed = false;
    if (o.fov > 0) { cam.fov = o.fov; changed = true; }
    if (o.nearPlane > 0) { cam.near = o.nearPlane; changed = true; }
    if (o.farPlane > o.nearPlane && o.farPlane > 0) { cam.far = o.farPlane; changed = true; }
    if (changed) cam.updateProjectionMatrix();
  }

  /**
   * Apply distance fog (and optionally paint the background the fog colour) to a
   * scene, matching the camera's far plane. Call once, or again when you change
   * fog options. Pass `{ fog:false }` beforehand (or call clearFog) to remove it.
   */
  applyFog(scene) {
    const o = this.options, THREE = this.THREE;
    if (!scene) return;
    if (!o.fog) { this.clearFog(scene); return; }
    const far = o.farPlane > 0 ? o.farPlane : this.camera.far;
    const start = clamp(o.fogStart, 0, 0.98);
    if (!this._fog) this._fog = new THREE.Fog(o.fogColor, 1, 2);
    this._fog.color.set(o.fogColor);
    this._fog.near = far * start;
    this._fog.far = far;
    scene.fog = this._fog;
    if (o.fogSky) {
      this._bg = this._bg || scene.background;
      scene.background = this._fog.color;
    }
  }

  clearFog(scene) {
    if (scene && scene.fog === this._fog) {
      scene.fog = null;
      if (this._bg !== undefined) scene.background = this._bg;
    }
  }

  /** Update any option(s) at runtime; re-applies projection if those changed. */
  set(opts = {}) {
    let proj = false;
    for (const k of Object.keys(opts)) {
      if (k in this.options) this.options[k] = opts[k];
      if (k === 'fov' || k === 'nearPlane' || k === 'farPlane') proj = true;
    }
    if (proj) this._applyProjection();
  }
}

export default ThirdPersonCamera;
