/**
 * `ws-dream`: the "dreaming" particle swirl shown while the LLM is thinking.
 * A pre-built client-side entity (never LLM-generated). One THREE.Points draw
 * call; all motion happens in the vertex shader, so the CPU cost per frame is
 * a single uniform update — safe for Quest 2 even during long waits.
 */
import AFRAME from 'aframe';

const THREE = AFRAME.THREE;
const COUNT = 420;

const VERT = /* glsl */`
  uniform float uTime;
  uniform float uSize;
  attribute vec4 aSeed; // radius, angle, height, speed
  varying float vMix;
  void main() {
    float r = aSeed.x;
    float a = aSeed.y + uTime * aSeed.w;
    float h = aSeed.z + sin(uTime * 0.7 + aSeed.y * 3.0) * 0.12;
    float pull = 0.85 + 0.15 * sin(uTime * 0.9 + r * 6.0);
    vec3 p = vec3(cos(a) * r * pull, h, sin(a) * r * pull);
    vMix = fract(aSeed.y * 0.159 + uTime * 0.05);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uSize * (1.0 / -mv.z);
    gl_Position = projectionMatrix * mv;
  }`;

const FRAG = /* glsl */`
  uniform float uOpacity;
  varying float vMix;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c);
    if (d > 0.5) discard;
    float glow = smoothstep(0.5, 0.0, d);
    vec3 col = mix(vec3(0.49, 0.36, 1.0), vec3(0.13, 0.83, 0.93), vMix);
    gl_FragColor = vec4(col * (0.6 + glow), glow * uOpacity);
  }`;

AFRAME.registerComponent('ws-dream', {
  schema: { distance: { default: 2.4 } },

  init() {
    const seeds = new Float32Array(COUNT * 4);
    for (let i = 0; i < COUNT; i++) {
      const r = 0.25 + Math.pow(Math.random(), 0.7) * 0.9;
      seeds.set([r, Math.random() * Math.PI * 2, (Math.random() - 0.5) * 0.9 * (1.2 - r * 0.5), (0.4 + Math.random() * 0.8) / r], i * 4);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
    geo.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 4));
    geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2); // positions are computed in the shader
    this.uniforms = { uTime: { value: 0 }, uOpacity: { value: 0 }, uSize: { value: 60 } };
    this.material = new THREE.ShaderMaterial({
      uniforms: this.uniforms, vertexShader: VERT, fragmentShader: FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
    });
    this.points = new THREE.Points(geo, this.material);
    this.points.frustumCulled = false;
    this.el.setObject3D('mesh', this.points);
    this.el.object3D.visible = false;
    this.active = false;
    this.camPos = new THREE.Vector3();
    this.camDir = new THREE.Vector3();
  },

  setActive(on) {
    if (on && !this.active) this.placeInFront();
    this.active = on;
    if (on) this.el.object3D.visible = true;
  },

  placeInFront() {
    const cam = this.el.sceneEl.camera;
    if (!cam) return;
    cam.getWorldPosition(this.camPos);
    cam.getWorldDirection(this.camDir);
    this.camDir.y = 0;
    if (this.camDir.lengthSq() < 1e-6) this.camDir.set(0, 0, -1);
    this.camDir.normalize();
    this.el.object3D.position.copy(this.camPos).addScaledVector(this.camDir, this.data.distance);
  },

  tick(t, dt) {
    const o = this.el.object3D;
    if (!o.visible) return;
    this.uniforms.uTime.value = t / 1000;
    const target = this.active ? 1 : 0;
    const k = 1 - Math.exp(-(dt || 16) / 250);
    this.uniforms.uOpacity.value += (target - this.uniforms.uOpacity.value) * k;
    if (!this.active && this.uniforms.uOpacity.value < 0.02) o.visible = false;
  },

  remove() {
    this.el.removeObject3D('mesh');
    this.points.geometry.dispose();
    this.material.dispose();
  }
});
