/* =========================================================================
   Sovngarde Notes - logica del salon
   La ronda de tomos es una escena 3D (three.js) con los modelos GLB reales.
   ========================================================================= */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SavePass } from 'three/addons/postprocessing/SavePass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

const $ = (sel) => document.querySelector(sel);

/* ---------- Perillas por URL -------------------------------------------
   Se declaran al principio porque se usan en todo el modulo. Utiles para
   ajustar en vivo sin volver a desplegar. */
const parametro = (nombre, porDefecto) => {
  const v = Number(new URLSearchParams(location.search).get(nombre));
  return Number.isFinite(v) && v > 0 ? v : porDefecto;
};

const BLOOM = parametro('bloom', 1) > 0;   // ?bloom=0 apaga el postprocesado
const AUDIO = parametro('audio', 1) > 0;   // ?audio=0 silencia la app

const els = {
  canvas:      $('#ring-canvas'),
  stage:       $('.stage'),
  stageEmpty:  $('#stage-empty'),
  stageNote:   $('#stage-note'),
  shelfMine:   $('#shelf-mine'),
  shelfOthers: $('#shelf-others'),
  countMine:   $('#count-mine'),
  countOthers: $('#count-others'),
  search:      $('#search'),
  searchHint:  $('#search-hint'),
  form:        $('#nota-form'),
  titulo:      $('#titulo'),
  texto:       $('#texto'),
  status:      $('#status-msg'),
  reader:      $('#reader'),
  gate:        $('#gate'),
  gateForm:    $('#gate-form'),
  gateName:    $('#gate-name'),
};

let notas = [];
let viajero = '';

/* ---------- Identidad del viajero -------------------------------------- */

function cargarViajero() {
  try { viajero = localStorage.getItem('sovngarde:viajero') || ''; }
  catch { viajero = ''; }
}

function guardarViajero(nombre) {
  viajero = nombre;
  try { localStorage.setItem('sovngarde:viajero', nombre); } catch { /* modo privado */ }
}

/* ---------- Audio sintetizado ------------------------------------------ */

let audioCtx = null;

function ctx() {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

const sinMovimiento = () =>
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* Un poco de sala: impulso sintetico (ruido que decae) para el convolver.
   Da la sensacion de que el libro se abre dentro de un salon de piedra. */
let impulso = null;

function reverb(ac) {
  if (impulso) return impulso;
  const dur = 1.9, rate = ac.sampleRate;
  const n = Math.floor(rate * dur);
  const buf = ac.createBuffer(2, n, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < n; i++) {
      const t = i / n;
      d[i] = (Math.random() * 2 - 1) * Math.pow(1 - t, 2.6) * 0.5;
    }
  }
  impulso = buf;
  return buf;
}

/* Nodo de entrada que reparte entre seco y reverberado */
function salida(ac, humedo = 0.24) {
  const entrada = ac.createGain();

  const seco = ac.createGain();
  seco.gain.value = 1 - humedo;
  entrada.connect(seco).connect(ac.destination);

  const conv = ac.createConvolver();
  conv.buffer = reverb(ac);
  const seco2 = ac.createGain();
  seco2.gain.value = humedo;
  entrada.connect(conv).connect(seco2).connect(ac.destination);

  return entrada;
}

/* Fuente de ruido con la envolvente que se le pase */
function ruido(ac, dur, envolvente) {
  const rate = ac.sampleRate;
  const n = Math.floor(rate * dur);
  const buf = ac.createBuffer(1, n, rate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * envolvente(i / n);
  const src = ac.createBufferSource();
  src.buffer = buf;
  return src;
}

/* Abrir un tomo pesado. Tres capas superpuestas:
   1. el golpe grave de la tapa al caer
   2. el crujido del cuero de la encuadernacion, irregular
   3. las hojas asentandose, en rafagas escalonadas */
function sonidoAbrirLibro() {
  if (sinMovimiento() || !AUDIO) return;
  try {
    const ac = ctx();
    const out = salida(ac, 0.26);
    const t0 = ac.currentTime;

    // --- 1. Golpe de la tapa: tono grave que cae ---
    const golpe = ac.createOscillator();
    golpe.type = 'sine';
    golpe.frequency.setValueAtTime(125, t0);
    golpe.frequency.exponentialRampToValueAtTime(50, t0 + 0.19);
    const gGolpe = ac.createGain();
    gGolpe.gain.setValueAtTime(0.0001, t0);
    gGolpe.gain.exponentialRampToValueAtTime(0.42, t0 + 0.012);
    gGolpe.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.32);
    golpe.connect(gGolpe).connect(out);
    golpe.start(t0);
    golpe.stop(t0 + 0.34);

    // cuerpo del golpe: ruido grave que le da peso
    const cuerpo = ruido(ac, 0.3, (t) => Math.exp(-11 * t));
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 240;
    const gCuerpo = ac.createGain();
    gCuerpo.gain.value = 0.45;
    cuerpo.connect(lp).connect(gCuerpo).connect(out);
    cuerpo.start(t0);

    // --- 2. Crujido del cuero ---
    // La envolvente lleva "granos" al azar: es lo que hace que suene a
    // material tensandose y no a un simple soplido.
    const crujido = ruido(ac, 0.6, (t) => {
      const env = Math.exp(-4.2 * t) * (t < 0.05 ? t / 0.05 : 1);
      const grano = Math.random() < 0.38 ? 1 : 0.22;
      return env * grano;
    });
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 4.5;
    bp.frequency.setValueAtTime(420, t0 + 0.02);
    bp.frequency.exponentialRampToValueAtTime(1180, t0 + 0.52);
    const gCrujido = ac.createGain();
    gCrujido.gain.value = 0.3;
    crujido.connect(bp).connect(gCrujido).connect(out);
    crujido.start(t0 + 0.02);

    // --- 3. Hojas asentandose ---
    [0.10, 0.25, 0.4].forEach((desfase, i) => {
      const hoja = ruido(ac, 0.32, (t) => Math.exp(-15 * t));
      const hp = ac.createBiquadFilter();
      hp.type = 'highpass';
      hp.frequency.value = 1500;
      const color = ac.createBiquadFilter();
      color.type = 'bandpass';
      color.frequency.value = 3000 + i * 750;
      color.Q.value = 0.8;
      const g = ac.createGain();
      g.gain.value = 0.2 - i * 0.045;
      hoja.connect(hp).connect(color).connect(g).connect(out);
      hoja.start(t0 + desfase);
    });
  } catch { /* si el navegador bloquea el audio, la app sigue */ }
}

/* Cerrar el tomo: golpe mas seco y corto, sin crujido */
function sonidoCerrarLibro() {
  if (sinMovimiento() || !AUDIO) return;
  try {
    const ac = ctx();
    const out = salida(ac, 0.2);
    const t0 = ac.currentTime;

    const golpe = ac.createOscillator();
    golpe.type = 'sine';
    golpe.frequency.setValueAtTime(105, t0);
    golpe.frequency.exponentialRampToValueAtTime(45, t0 + 0.14);
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.34, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.24);
    golpe.connect(g).connect(out);
    golpe.start(t0);
    golpe.stop(t0 + 0.26);

    const aire = ruido(ac, 0.22, (t) => Math.exp(-13 * t));
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 900;
    const ga = ac.createGain();
    ga.gain.value = 0.26;
    aire.connect(lp).connect(ga).connect(out);
    aire.start(t0);
  } catch { /* idem */ }
}

/* Hoja pasando: sonido corto, para cuando se graba una nota */
function sonidoPagina() {
  if (sinMovimiento() || !AUDIO) return;
  try {
    const ac = ctx();
    const out = salida(ac, 0.18);
    const hoja = ruido(ac, 0.42, (t) => {
      const a = Math.exp(-14 * t);
      const b = t > 0.34 ? Math.exp(-16 * (t - 0.34)) * 0.75 : 0;
      return (a + b) * 0.5;
    });
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 0.7;
    const hp = ac.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 900;
    const vol = ac.createGain();
    vol.gain.value = 0.18;
    hoja.connect(bp).connect(hp).connect(vol).connect(out);
    hoja.start();
  } catch { /* idem */ }
}

/* Rugido del dragon: ruido grave con el filtro cayendo */
function rugido() {
  if (sinMovimiento() || !AUDIO) return;
  try {
    const ac = ctx();
    const dur = 0.9, rate = ac.sampleRate;
    const frames = Math.floor(rate * dur);
    const buf = ac.createBuffer(1, frames, rate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < frames; i++) {
      const t = i / frames;
      data[i] = (Math.random() * 2 - 1) * Math.exp(-3.2 * t) * (1 - t * 0.3);
    }

    const src = ac.createBufferSource(); src.buffer = buf;
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(900, ac.currentTime);
    lp.frequency.exponentialRampToValueAtTime(260, ac.currentTime + dur);
    const vol = ac.createGain(); vol.gain.value = 0.2;

    src.connect(lp).connect(vol).connect(ac.destination);
    src.start();
  } catch { /* idem */ }
}

/* ---------- Utilidades -------------------------------------------------- */

function formatFecha(iso) {
  const d = new Date(iso);
  return isNaN(d) ? '' : d.toLocaleString('es-AR', { dateStyle: 'long', timeStyle: 'short' });
}

/* "hace 5 minutos", "ayer", "hace 2 meses"... */
const relativo = new Intl.RelativeTimeFormat('es-AR', { numeric: 'auto' });
const TRAMOS = [
  ['year', 31536000], ['month', 2592000], ['week', 604800],
  ['day', 86400], ['hour', 3600], ['minute', 60],
];

function fechaRelativa(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const seg = (Date.now() - d.getTime()) / 1000;
  for (const [unidad, largo] of TRAMOS) {
    if (Math.abs(seg) >= largo) return relativo.format(-Math.round(seg / largo), unidad);
  }
  return relativo.format(-Math.round(seg), 'second');
}

function esMia(nota) {
  return viajero && nota.autor &&
         nota.autor.trim().toLowerCase() === viajero.trim().toLowerCase();
}

function tituloDe(nota, max = 30) {
  let t = (nota.titulo || '').trim();
  if (!t || t === 'Tomo sin titulo') t = (nota.texto || '').trim();
  t = t.replace(/\s+/g, ' ');
  return t.length > max ? t.slice(0, max) + '...' : t;
}

/* =========================================================================
   Escena 3D de la ronda
   ========================================================================= */

const MAX_EN_RONDA = 40; // limite por performance; el resto vive en las estanterias

const ring3d = {
  ok: false,
  scene: null, camera: null, renderer: null,
  grupo: null,
  modelos: {},
  tomos: [],
  raycaster: new THREE.Raycaster(),
  puntero: new THREE.Vector2(),
  reloj: new THREE.Clock(),
  pausado: false,
  radio: 3,
  destellos: null,   // aura de sanacion (tomos propios)
  rayos: null,       // descargas electricas (tomos ajenos)
  hover: null,
  composer: null,
  // Arrastre e inercia
  arrastrando: false,
  ultimoX: 0,
  recorrido: 0,
  velocidad: 0,
  zoom: 1,
};


/* ---------- Texturas generadas al vuelo -------------------------------- */

function texturaPunto(interior = 'rgba(255,255,255,1)', exterior = 'rgba(255,255,255,0)') {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 64;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, interior);
  g.addColorStop(0.35, interior);
  g.addColorStop(1, exterior);
  c.fillStyle = g;
  c.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function texturaHalo() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const c = cv.getContext('2d');
  const g = c.createRadialGradient(128, 128, 10, 128, 128, 128);
  g.addColorStop(0,    'rgba(255,240,200,.85)');
  g.addColorStop(0.28, 'rgba(255,215,130,.42)');
  g.addColorStop(0.6,  'rgba(180,240,210,.16)');
  g.addColorStop(1,    'rgba(180,240,210,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* Destello de cuatro puntas, para el aura de sanacion */
function texturaEstrella() {
  const cv = document.createElement('canvas');
  cv.width = cv.height = 128;
  const c = cv.getContext('2d');

  const g = c.createRadialGradient(64, 64, 0, 64, 64, 30);
  g.addColorStop(0,    'rgba(255,255,255,1)');
  g.addColorStop(0.22, 'rgba(170,255,190,.9)');
  g.addColorStop(1,    'rgba(90,240,140,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, 128, 128);

  c.globalCompositeOperation = 'lighter';

  const punta = (rot, largo, ancho, color) => {
    c.save();
    c.translate(64, 64);
    c.rotate(rot);
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(0, -largo);
    c.lineTo(ancho, 0);
    c.lineTo(0, largo);
    c.lineTo(-ancho, 0);
    c.closePath();
    c.fill();
    c.restore();
  };

  punta(0, 62, 4.5, 'rgba(215,255,225,.95)');
  punta(Math.PI / 2, 62, 4.5, 'rgba(215,255,225,.95)');
  punta(Math.PI / 4, 30, 2.5, 'rgba(150,255,180,.55)');
  punta(-Math.PI / 4, 30, 2.5, 'rgba(150,255,180,.55)');

  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* El postprocesado descarta el canal alfa y deja el canvas opaco: se veia
   un rectangulo negro detras de los libros, tapando el fondo de la pagina.
   Este shader final toma el color ya procesado y le devuelve la
   transparencia guardada antes del bloom. */
const ShaderAlfa = {
  uniforms: {
    tDiffuse: { value: null },   // imagen con bloom y tono aplicados
    tAlfa:    { value: null },   // copia previa, de donde sale el alfa
  },
  vertexShader: `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform sampler2D tAlfa;
    varying vec2 vUv;
    void main() {
      vec4 color = texture2D(tDiffuse, vUv);
      float alfa = texture2D(tAlfa, vUv).a;
      // El bloom suma luz alrededor de los objetos: se deja que esa luz
      // tambien aporte opacidad, si no el halo se corta de golpe en el borde.
      float halo = clamp(max(max(color.r, color.g), color.b), 0.0, 1.0);
      gl_FragColor = vec4(color.rgb, max(alfa, halo * 0.9));
    }
  `,
};

/* Cielo equirectangular sintetico: le da al oro de las tapas algo que
   reflejar. Sin esto los materiales PBR quedan planos, porque la escena
   solo tiene luces direccionales y nada alrededor. */
function texturaEntorno() {
  const cv = document.createElement('canvas');
  cv.width = 512; cv.height = 256;
  const c = cv.getContext('2d');

  // Degradado vertical: noche abajo, aurora arriba
  const g = c.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0,    '#0a1c2c');
  g.addColorStop(0.34, '#12405a');
  g.addColorStop(0.5,  '#1d6b76');
  g.addColorStop(0.62, '#2a8f78');
  g.addColorStop(0.8,  '#0d2436');
  g.addColorStop(1,    '#050a12');
  c.fillStyle = g;
  c.fillRect(0, 0, 512, 256);

  // Cintas de aurora difusas, para que los reflejos no sean uniformes
  c.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 7; i++) {
    const x = Math.random() * 512;
    const w = 40 + Math.random() * 110;
    const cinta = c.createLinearGradient(x, 0, x + w, 0);
    cinta.addColorStop(0, 'rgba(70,227,154,0)');
    cinta.addColorStop(0.5, `rgba(${90 + Math.random() * 60 | 0},235,${180 + Math.random() * 60 | 0},.5)`);
    cinta.addColorStop(1, 'rgba(79,201,232,0)');
    c.fillStyle = cinta;
    c.fillRect(x, 20, w, 150);
  }

  // Un foco calido, que hace de luz principal en los reflejos
  const foco = c.createRadialGradient(400, 90, 4, 400, 90, 90);
  foco.addColorStop(0, 'rgba(255,228,170,.95)');
  foco.addColorStop(1, 'rgba(255,228,170,0)');
  c.fillStyle = foco;
  c.fillRect(310, 0, 180, 180);

  const t = new THREE.CanvasTexture(cv);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------- Efectos ----------------------------------------------------- */

/* Aura de sanacion (tomos propios): enjambre de destellos verdes de cuatro
   puntas que titilan y ascienden en espiral alrededor del libro. */
function crearDestellos() {
  const grupo = new THREE.Group();
  const tex = texturaEstrella();
  const items = [];

  for (let i = 0; i < 30; i++) {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({
      map: tex, color: 0x9dffb4, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    grupo.add(sp);
    items.push({
      sp,
      fase: Math.random(),
      vel:  0.22 + Math.random() * 0.3,
      base: 0.16 + Math.random() * 0.2,
      ang:  Math.random() * Math.PI * 2,
      rad:  0.25 + Math.random() * 0.62,
      giro: (Math.random() - 0.5) * 0.5,
    });
  }

  grupo.visible = false;
  grupo.userData = { items };
  return grupo;
}

/* Polilinea quebrada por desplazamiento del punto medio: da el aspecto
   de descarga electrica. 5 pasadas sobre 2 puntos -> 33 puntos. */
function trazarRayo(a, b, pasadas, caos) {
  let pts = [a.clone(), b.clone()];
  for (let paso = 0; paso < pasadas; paso++) {
    const salida = [];
    const amp = caos / (paso + 1);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i], p1 = pts[i + 1];
      const medio = p0.clone().add(p1).multiplyScalar(0.5);
      medio.x += (Math.random() - 0.5) * amp;
      medio.y += (Math.random() - 0.5) * amp;
      medio.z += (Math.random() - 0.5) * amp;
      salida.push(p0, medio);
    }
    salida.push(pts[pts.length - 1]);
    pts = salida;
  }
  return pts;
}

const PUNTOS_RAYO = 33;

/* Rayos (tomos ajenos): arcos cian que nacen del libro, lo recorren y se
   apagan de golpe, reapareciendo en otra posicion. */
function crearRayos() {
  const grupo = new THREE.Group();
  const arcos = [];

  for (let i = 0; i < 6; i++) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(PUNTOS_RAYO * 3), 3));
    const linea = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0xbdf4ff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    grupo.add(linea);
    arcos.push({ linea, vida: Math.random() * 0.3, duracion: 0.16 + Math.random() * 0.2 });
  }

  const nucleo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texturaPunto('rgba(200,245,255,1)'),
    color: 0x7fe4ff, transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  nucleo.scale.setScalar(1.5);
  grupo.add(nucleo);

  grupo.visible = false;
  grupo.userData = { arcos, nucleo, caja: new THREE.Vector3(1, 1.4, 0.6) };
  return grupo;
}

/* ---------- Montaje de la escena ---------------------------------------- */

function initEscena() {
  ring3d.renderer = new THREE.WebGLRenderer({ canvas: els.canvas, alpha: true, antialias: true });
  ring3d.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  ring3d.renderer.outputColorSpace = THREE.SRGBColorSpace;
  ring3d.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  ring3d.renderer.toneMappingExposure = 1.15;
  // Fondo transparente: detras del canvas se ve la foto de la aurora
  ring3d.renderer.setClearColor(0x000000, 0);

  ring3d.scene = new THREE.Scene();

  // FOV cerrado a proposito: con un angulo ancho los tomos del fondo del
  // anillo se veian a poco mas de la mitad del tamano de los de adelante.
  ring3d.camera = new THREE.PerspectiveCamera(18, 1, 0.1, 200);
  ring3d.camera.position.set(0, 2.2, 14);
  ring3d.camera.lookAt(0, 0, 0);

  // Environment map: reflejos para el oro repujado de las tapas
  const pmrem = new THREE.PMREMGenerator(ring3d.renderer);
  pmrem.compileEquirectangularShader();
  const entorno = texturaEntorno();
  ring3d.scene.environment = pmrem.fromEquirectangular(entorno).texture;
  ring3d.scene.environmentIntensity = 0.85;
  entorno.dispose();
  pmrem.dispose();

  ring3d.scene.add(new THREE.HemisphereLight(0x9fe8ff, 0x101c26, 0.9));

  const key = new THREE.DirectionalLight(0xffe3ad, 1.7);
  key.position.set(3, 5, 4);
  ring3d.scene.add(key);

  const rim = new THREE.DirectionalLight(0x66e0c0, 0.9);
  rim.position.set(-4, 2, -3);
  ring3d.scene.add(rim);

  const fill = new THREE.DirectionalLight(0xffffff, 0.5);
  fill.position.set(0, 1, 8);
  ring3d.scene.add(fill);

  ring3d.grupo = new THREE.Group();
  ring3d.scene.add(ring3d.grupo);

  // Un solo juego de efectos, reutilizado: se reposiciona sobre el tomo
  // apuntado en vez de crear particulas para cada libro.
  ring3d.destellos = crearDestellos();
  ring3d.rayos = crearRayos();
  ring3d.grupo.add(ring3d.destellos, ring3d.rayos);

  // Bloom: hace que los destellos, los rayos y el oro tengan halo real.
  // Se puede apagar con ?bloom=0 si el equipo va justo de rendimiento.
  if (BLOOM) {
    ring3d.renderer.setClearColor(0x000000, 0);

    ring3d.composer = new EffectComposer(ring3d.renderer);

    const render = new RenderPass(ring3d.scene, ring3d.camera);
    render.clearAlpha = 0;
    ring3d.composer.addPass(render);

    // Copia de la escena tal cual salio, para recuperar el alfa al final
    const guardado = new SavePass();
    ring3d.composer.addPass(guardado);

    ring3d.composer.addPass(new UnrealBloomPass(
      new THREE.Vector2(1, 1),
      0.55,  // fuerza
      0.5,   // radio
      0.72   // umbral: solo lo mas brillante genera halo
    ));

    const salidaTono = new OutputPass();
    salidaTono.renderToScreen = false;
    ring3d.composer.addPass(salidaTono);

    const restaurarAlfa = new ShaderPass(ShaderAlfa);
    restaurarAlfa.uniforms.tAlfa.value = guardado.renderTarget.texture;
    restaurarAlfa.renderToScreen = true;
    ring3d.composer.addPass(restaurarAlfa);
  }

  redimensionar();
  window.addEventListener('resize', redimensionar);

  els.canvas.addEventListener('pointerdown', alBajarPuntero);
  els.canvas.addEventListener('pointermove', alMoverPuntero);
  els.canvas.addEventListener('pointerup', alSoltarPuntero);
  els.canvas.addEventListener('pointercancel', alSoltarPuntero);
  els.canvas.addEventListener('pointerleave', () => {
    ring3d.puntero.set(999, 999);
    ring3d.arrastrando = false;
  });
  els.canvas.addEventListener('wheel', alRodar, { passive: false });

  ring3d.renderer.setAnimationLoop(animar);
  ring3d.ok = true;
}

function redimensionar() {
  if (!ring3d.renderer) return;
  const w = els.stage.clientWidth, h = els.stage.clientHeight;
  if (!w || !h) return;
  ring3d.renderer.setSize(w, h, false);
  ring3d.composer?.setSize(w, h);
  ring3d.camera.aspect = w / h;
  ring3d.camera.updateProjectionMatrix();
  encuadrarCamara();
}

/* Centra, orienta y escala un modelo recien cargado. El eje mas delgado
   pasa a ser Z, asi la tapa mira hacia afuera de la ronda. */
const TAPA_ANCHO = 1.40;
const TAPA_ALTO  = 1.60;

/* Cuanto se agranda el tomo ajeno. Las medidas dicen que las dos tapas
   quedan iguales, pero en pantalla el ajeno se lee mas chico, asi que se
   lo agranda a mano. Se puede probar otro valor con ?escala=1.9 */
const AJUSTE_OTROS = parametro('escala', 1.8);

/* Que porcion del tomo ocupa el area sensible al puntero.
   Al agrandar el modelo, su caja crecio junto con el: esto la vuelve a
   ajustar al libro visible sin tocar el tamano. Se prueba con ?hitbox=0.5 */
const HITBOX_OTROS = parametro('hitbox', 1 / AJUSTE_OTROS);

function normalizarModelo(gltfScene, ajuste = 1) {
  const contenedor = new THREE.Group();
  const interno = new THREE.Group();
  interno.add(gltfScene);
  contenedor.add(interno);

  let caja = new THREE.Box3().setFromObject(interno);
  const tam = caja.getSize(new THREE.Vector3());
  const dims = [tam.x, tam.y, tam.z];
  const iMin = dims.indexOf(Math.min(...dims));

  if (iMin === 0) interno.rotation.y = Math.PI / 2;
  else if (iMin === 1) interno.rotation.x = -Math.PI / 2;

  interno.updateMatrixWorld(true);
  caja = new THREE.Box3().setFromObject(interno);
  const tam2 = caja.getSize(new THREE.Vector3());
  const centro = caja.getCenter(new THREE.Vector3());

  interno.position.sub(centro);

  // Escala independiente por eje: los dos modelos tienen proporciones
  // nativas distintas (el ajeno es 10% mas angosto y 10% mas alto), asi que
  // cualquier escala uniforme deja uno mas chico que el otro. Escalando X e
  // Y por separado las dos tapas quedan exactamente del mismo tamano en
  // pantalla; la deformacion es de ~10% y no se nota.
  // El escalado va en el contenedor, que no tiene rotacion propia, asi que
  // se aplica sobre el libro ya orientado y no lo deforma en diagonal.
  const sx = (TAPA_ANCHO / tam2.x) * ajuste;
  const sy = (TAPA_ALTO  / tam2.y) * ajuste;
  const sz = (sx + sy) / 2;   // el grosor sigue el promedio, sin achatarse
  contenedor.scale.set(sx, sy, sz);

  contenedor.userData.tamano = new THREE.Vector3(
    tam2.x * sx, tam2.y * sy, tam2.z * sz
  );
  return contenedor;
}

async function cargarModelos() {
  const loader = new GLTFLoader();
  const cargar = (url) => new Promise((res, rej) => loader.load(url, res, undefined, rej));
  const [mine, others] = await Promise.all([
    cargar('models/tome-mine.glb'),
    cargar('models/tome-others.glb'),
  ]);
  ring3d.modelos.mine = normalizarModelo(mine.scene, 1);
  ring3d.modelos.others = normalizarModelo(others.scene, AJUSTE_OTROS);

  // Diagnostico: deja los tamanos medidos a la vista en la consola, para
  // poder comparar lo que calcula el codigo con lo que se ve en pantalla.
  const medir = (m, nombre) => {
    const t = m.userData.tamano;
    console.log(`[tomo] ${nombre}: ancho ${t.x.toFixed(3)}  alto ${t.y.toFixed(3)}  grosor ${t.z.toFixed(3)}`);
  };
  medir(ring3d.modelos.mine, 'propio');
  medir(ring3d.modelos.others, `ajeno (escala ${AJUSTE_OTROS}, hitbox ${HITBOX_OTROS.toFixed(2)})`);
  window.__sovngarde = ring3d;
}

/* Rotulo con titulo y autor, dibujado en canvas y pegado sobre la tapa */
function crearRotulo(nota, ancho, alto) {
  const cv = document.createElement('canvas');
  cv.width = 640; cv.height = 200;
  const c = cv.getContext('2d');

  c.clearRect(0, 0, cv.width, cv.height);
  c.textAlign = 'center';
  c.shadowColor = 'rgba(0,0,0,.85)';
  c.shadowBlur = 10;
  c.shadowOffsetY = 3;

  c.fillStyle = '#f6e6bd';
  c.font = '700 62px Cinzel, Georgia, serif';
  c.fillText(tituloDe(nota, 22), cv.width / 2, 84, cv.width - 40);

  c.fillStyle = 'rgba(240,205,140,.92)';
  c.font = '500 42px Cinzel, Georgia, serif';
  c.fillText((nota.autor || '').toUpperCase(), cv.width / 2, 150, cv.width - 60);

  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;

  const w = ancho * 0.78;
  const plano = new THREE.Mesh(
    new THREE.PlaneGeometry(w, w * (200 / 640)),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })
  );
  plano.position.y = -alto * 0.26;
  return plano;
}

/* Clona la plantilla con materiales propios, para poder atenuar o iluminar
   un tomo sin afectar a los demas. */
function instanciarTomo(nota) {
  const propio = esMia(nota);
  const plantilla = propio ? ring3d.modelos.mine : ring3d.modelos.others;
  const modelo = plantilla.clone(true);
  const tam = plantilla.userData.tamano;

  const materiales = [];
  modelo.traverse((n) => {
    if (n.isMesh) {
      n.material = n.material.clone();
      n.material.transparent = true;
      materiales.push({
        mat: n.material,
        emisivaBase: n.material.emissive ? n.material.emissive.clone() : null,
        intensidadBase: n.material.emissiveIntensity ?? 1,
      });
    }
  });

  // Grupo externo SIN escala propia. El modelo va adentro con su escala,
  // y el rotulo, el halo y la caja de colision cuelgan de aca, en tamano
  // real. Antes eran hijos del modelo escalado y se multiplicaban dos
  // veces: con el tomo ajeno agrandado quedaban al doble de tamano.
  const obj = new THREE.Group();
  obj.add(modelo);

  // El area sensible se calcula aparte del tamano visual: al agrandar el
  // modelo su caja crecio igual, y quedaba capturando el puntero mucho mas
  // alla del libro.
  const factorHit = propio ? 1 : HITBOX_OTROS;
  const tamHit = tam.clone().multiplyScalar(factorHit);

  const rotulo = crearRotulo(nota, tamHit.x, tamHit.y);
  rotulo.position.z = tamHit.z / 2 + 0.012;
  obj.add(rotulo);

  const halo = new THREE.Sprite(new THREE.SpriteMaterial({
    map: texturaHalo(), transparent: true, opacity: 0,
    blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  halo.scale.setScalar(Math.max(tamHit.x, tamHit.y) * 2.4);
  halo.visible = false;
  obj.add(halo);

  // Caja de colision: 12 triangulos, ajustada al libro visible. Va suelta
  // en la ronda para no heredar transformaciones.
  const hit = new THREE.Mesh(
    new THREE.BoxGeometry(tamHit.x, tamHit.y, tamHit.z),
    new THREE.MeshBasicMaterial({ visible: false })
  );

  return { obj, materiales, tam: tamHit, halo, hit };
}

function construirRonda() {
  if (!ring3d.ok) return;

  for (const t of ring3d.tomos) {
    ring3d.grupo.remove(t.obj);
    if (t.hit) {
      ring3d.grupo.remove(t.hit);
      t.hit.geometry.dispose();
      t.hit.material.dispose();
    }
    t.obj.traverse((n) => {
      if (n.isMesh) {
        n.geometry?.dispose?.();
        n.material?.map?.dispose?.();
        n.material?.dispose?.();
      }
    });
  }
  ring3d.tomos = [];
  ring3d.hover = null;
  ring3d.destellos.visible = false;
  ring3d.rayos.visible = false;

  const enRonda = notas.slice(0, MAX_EN_RONDA);
  const total = enRonda.length;

  els.stageEmpty.hidden = total > 0;
  els.stageNote.textContent = notas.length > MAX_EN_RONDA
    ? `Se muestran los ${MAX_EN_RONDA} tomos mas recientes en la ronda.`
    : '';

  if (!total) { encuadrarCamara(); return; }

  const anchoTomo = ring3d.modelos.mine.userData.tamano.x * 1.45;
  ring3d.radio = Math.max(2.2, (total * anchoTomo) / (2 * Math.PI));

  enRonda.forEach((nota, i) => {
    const inst = instanciarTomo(nota);
    const ang = (i / total) * Math.PI * 2;

    inst.obj.position.set(Math.sin(ang) * ring3d.radio, 0, Math.cos(ang) * ring3d.radio);
    inst.obj.rotation.y = ang;
    inst.obj.userData.notaId = String(nota.id);

    inst.hit.position.copy(inst.obj.position);
    inst.hit.rotation.y = ang;
    inst.hit.userData.notaId = String(nota.id);

    ring3d.grupo.add(inst.obj, inst.hit);
    ring3d.tomos.push({
      nota, obj: inst.obj, hit: inst.hit, materiales: inst.materiales,
      halo: inst.halo, tam: inst.tam, resaltado: false,
    });
  });

  encuadrarCamara();
  aplicarBusqueda();
}

function encuadrarCamara() {
  if (!ring3d.camera) return;
  const fov = THREE.MathUtils.degToRad(ring3d.camera.fov);
  const necesaria = (ring3d.radio + 1.1) / Math.tan(fov / 2);
  const dist = Math.max(9, necesaria / Math.min(1, ring3d.camera.aspect * 0.9)) * ring3d.zoom;
  ring3d.camera.position.set(0, dist * 0.16, dist);
  ring3d.camera.lookAt(0, 0, 0);
}

/* ---------- Puntero ----------------------------------------------------- */

function alMoverPuntero(e) {
  const r = els.canvas.getBoundingClientRect();
  ring3d.puntero.x = ((e.clientX - r.left) / r.width) * 2 - 1;
  ring3d.puntero.y = -((e.clientY - r.top) / r.height) * 2 + 1;

  if (ring3d.arrastrando) {
    const dx = e.clientX - ring3d.ultimoX;
    ring3d.ultimoX = e.clientX;
    ring3d.recorrido += Math.abs(dx);
    // La velocidad queda guardada para que la ronda siga girando al soltar
    ring3d.velocidad = dx * 0.006;
    ring3d.grupo.rotation.y += ring3d.velocidad;
  }
}

/* Resuelve que tomo esta bajo el puntero y enciende el efecto que
   corresponda: sanacion para los propios, rayos para los ajenos. */
function actualizarHover() {
  ring3d.raycaster.setFromCamera(ring3d.puntero, ring3d.camera);
  const hits = ring3d.raycaster.intersectObjects(ring3d.tomos.map((t) => t.hit), false);

  let encontrado = null;
  if (hits.length) {
    const id = hits[0].object.userData.notaId;
    encontrado = ring3d.tomos.find((t) => String(t.nota.id) === id) || null;
  }

  if (encontrado === ring3d.hover) return;
  ring3d.hover = encontrado;
  if (!ring3d.arrastrando) els.canvas.style.cursor = encontrado ? 'pointer' : 'grab';

  const { destellos, rayos } = ring3d;
  destellos.visible = false;
  rayos.visible = false;

  if (!encontrado) return;

  const propio = esMia(encontrado.nota);
  const efecto = propio ? destellos : rayos;
  const tam = encontrado.tam || { x: 1, y: 1.4, z: 0.6 };

  efecto.visible = true;
  efecto.position.copy(encontrado.obj.position);
  efecto.rotation.y = encontrado.obj.rotation.y;

  if (propio) {
    for (const it of destellos.userData.items) {
      it.fase = Math.random();
      it.rad = 0.25 + Math.random() * Math.max(tam.x, tam.y) * 0.55;
      it.ang = Math.random() * Math.PI * 2;
    }
  } else {
    rayos.userData.caja.set(tam.x * 0.55, tam.y * 0.55, tam.z * 0.75);
    for (const a of rayos.userData.arcos) a.vida = Math.random() * a.duracion;
    rayos.userData.nucleo.scale.setScalar(Math.max(tam.x, tam.y) * 1.15);
  }
}

/* El puntero cumple dos funciones: arrastrar la ronda y abrir un tomo.
   Se distinguen por cuanto se movio entre apretar y soltar. */

const UMBRAL_ARRASTRE = 6; // px; por debajo de esto cuenta como click

function alBajarPuntero(e) {
  if (!ring3d.ok) return;
  ring3d.arrastrando = true;
  ring3d.ultimoX = e.clientX;
  ring3d.recorrido = 0;
  ring3d.velocidad = 0;
  els.canvas.setPointerCapture?.(e.pointerId);
  els.canvas.style.cursor = 'grabbing';
}

function alSoltarPuntero(e) {
  if (!ring3d.arrastrando) return;
  ring3d.arrastrando = false;
  els.canvas.releasePointerCapture?.(e.pointerId);
  els.canvas.style.cursor = ring3d.hover ? 'pointer' : 'grab';

  // Movimiento corto: era un click, no un arrastre
  if (ring3d.recorrido < UMBRAL_ARRASTRE) {
    ring3d.velocidad = 0;
    abrirTomoBajoPuntero(e);
  }
}

function abrirTomoBajoPuntero(e) {
  if (!ring3d.tomos.length) return;
  alMoverPuntero(e);
  ring3d.raycaster.setFromCamera(ring3d.puntero, ring3d.camera);

  const hits = ring3d.raycaster.intersectObjects(ring3d.tomos.map((t) => t.hit), false);
  if (!hits.length) return;

  const id = hits[0].object.userData.notaId;
  const t = ring3d.tomos.find((x) => String(x.nota.id) === id);
  if (t) abrirTomo(t.nota);
}

/* Rueda del mouse: acerca o aleja la camara, dentro de un rango acotado */
function alRodar(e) {
  if (!ring3d.ok) return;
  e.preventDefault();
  ring3d.zoom = THREE.MathUtils.clamp(ring3d.zoom * (e.deltaY > 0 ? 1.08 : 0.926), 0.55, 2.2);
  encuadrarCamara();
}

/* ---------- Bucle de animacion ------------------------------------------ */

function animar() {
  const dt = Math.min(ring3d.reloj.getDelta(), 0.05);
  const t = ring3d.reloj.getElapsedTime();

  if (ring3d.arrastrando) {
    // Mientras se arrastra manda el puntero; no se suma giro automatico
  } else if (Math.abs(ring3d.velocidad) > 0.0002) {
    // Inercia: sigue girando y frena de a poco
    ring3d.grupo.rotation.y += ring3d.velocidad;
    ring3d.velocidad *= 0.94;
  } else if (!ring3d.pausado) {
    ring3d.velocidad = 0;
    ring3d.grupo.rotation.y += dt * 0.14;
  }

  actualizarHover();

  for (const tomo of ring3d.tomos) {
    const objetivo = tomo.resaltado ? 0.42 + Math.sin(t * 1.8) * 0.05 : 0;
    tomo.obj.position.y += (objetivo - tomo.obj.position.y) * Math.min(1, dt * 6);
    if (tomo.hit) tomo.hit.position.y = tomo.obj.position.y;

    if (tomo.halo) {
      const meta = tomo.resaltado ? 0.55 + Math.sin(t * 2.4) * 0.14 : 0;
      const m = tomo.halo.material;
      m.opacity += (meta - m.opacity) * Math.min(1, dt * 5);
      tomo.halo.visible = m.opacity > 0.01;
    }
  }

  // El efecto acompana al tomo apuntado, incluso mientras este se eleva
  if (ring3d.hover) {
    const ef = esMia(ring3d.hover.nota) ? ring3d.destellos : ring3d.rayos;
    ef.position.y = ring3d.hover.obj.position.y;
  }

  animarDestellos(dt, t);
  animarRayos(dt);

  if (ring3d.composer) ring3d.composer.render();
  else ring3d.renderer.render(ring3d.scene, ring3d.camera);
}

function animarDestellos(dt, t) {
  const gr = ring3d.destellos;
  if (!gr) return;

  if (!gr.visible) {
    for (const it of gr.userData.items) it.sp.material.opacity = 0;
    return;
  }

  for (const it of gr.userData.items) {
    it.fase += dt * it.vel;
    if (it.fase > 1) it.fase -= 1;
    it.ang += dt * it.giro;

    it.sp.position.set(
      Math.cos(it.ang) * it.rad,
      -0.75 + it.fase * 1.7,
      Math.sin(it.ang) * it.rad
    );

    // Titileo: nacen, brillan y se apagan dentro de su ciclo
    const brillo = Math.sin(it.fase * Math.PI);
    it.sp.material.opacity = brillo * 0.92;
    const pulso = 0.75 + Math.sin(t * 7 + it.ang * 3) * 0.25;
    it.sp.scale.setScalar(it.base * brillo * pulso * 2.2 + 0.02);
  }
}

function animarRayos(dt) {
  const gr = ring3d.rayos;
  if (!gr) return;

  const { arcos, nucleo, caja } = gr.userData;

  if (!gr.visible) {
    for (const a of arcos) a.linea.material.opacity = 0;
    nucleo.material.opacity = 0;
    return;
  }

  nucleo.material.opacity = Math.min(0.32, nucleo.material.opacity + dt * 2.5);

  const desde = new THREE.Vector3();
  const hasta = new THREE.Vector3();

  for (const a of arcos) {
    a.vida -= dt;

    if (a.vida <= 0) {
      a.duracion = 0.14 + Math.random() * 0.22;
      a.vida = a.duracion;

      const cara = Math.random() > 0.45 ? 1 : -1;
      desde.set(
        (Math.random() - 0.5) * caja.x * 2,
        (Math.random() - 0.5) * caja.y * 2,
        caja.z * cara
      );
      // El otro extremo sale hacia afuera: el rayo "emana" del libro
      hasta.set(
        (Math.random() - 0.5) * caja.x * 3.2,
        (Math.random() - 0.5) * caja.y * 3.2,
        caja.z * cara * (1 + Math.random() * 1.8)
      );

      const pts = trazarRayo(desde, hasta, 5, Math.max(caja.x, caja.y) * 1.1);
      const arr = a.linea.geometry.attributes.position.array;
      for (let i = 0; i < PUNTOS_RAYO; i++) {
        const p = pts[Math.min(i, pts.length - 1)];
        arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
      }
      a.linea.geometry.attributes.position.needsUpdate = true;
      a.linea.material.opacity = 0.95;
    } else {
      // Se apaga de golpe al final, como una descarga real
      const k = a.vida / a.duracion;
      a.linea.material.opacity = k * k * 0.95;
    }
  }
}

/* ---------- Bibliotecas laterales --------------------------------------- */

function renderEstanterias() {
  const mias  = notas.filter(esMia);
  const otras = notas.filter((n) => !esMia(n));

  pintarEstante(els.shelfMine, mias);
  pintarEstante(els.shelfOthers, otras);

  els.countMine.textContent   = `${mias.length} ${mias.length === 1 ? 'tomo' : 'tomos'}`;
  els.countOthers.textContent = `${otras.length} ${otras.length === 1 ? 'tomo' : 'tomos'}`;
}

function pintarEstante(contenedor, lista) {
  contenedor.innerHTML = '';

  if (!lista.length) {
    const vacio = document.createElement('p');
    vacio.className = 'shelf-empty';
    vacio.textContent = '—';
    contenedor.appendChild(vacio);
    return;
  }

  lista.slice(0, 12).forEach((nota) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tome';
    btn.dataset.id = String(nota.id);
    btn.textContent = tituloDe(nota, 32);
    btn.title = `${tituloDe(nota, 80)} — ${nota.autor} — ${fechaRelativa(nota.fecha_creacion)}`;
    btn.addEventListener('click', () => abrirTomo(nota));
    contenedor.appendChild(btn);
  });
}

/* ---------- Buscador ----------------------------------------------------- */

function aplicarBusqueda() {
  const q = els.search.value.trim().toLowerCase();
  const tomosDom = document.querySelectorAll('.tome');

  if (!q) {
    ring3d.pausado = false;
    els.searchHint.textContent = '';
    for (const t of ring3d.tomos) { t.resaltado = false; atenuar(t, false); }
    tomosDom.forEach((el) => el.classList.remove('is-hit', 'is-dim'));
    return;
  }

  const coincide = (n) =>
    (n.titulo || '').toLowerCase().includes(q) ||
    (n.texto  || '').toLowerCase().includes(q) ||
    (n.autor  || '').toLowerCase().includes(q);

  const ids = new Set(notas.filter(coincide).map((n) => String(n.id)));
  ring3d.pausado = ids.size > 0;

  for (const t of ring3d.tomos) {
    const hit = ids.has(String(t.nota.id));
    t.resaltado = hit;
    atenuar(t, !hit);
  }

  tomosDom.forEach((el) => {
    const hit = ids.has(el.dataset.id);
    el.classList.toggle('is-hit', hit);
    el.classList.toggle('is-dim', !hit);
  });

  const n = ids.size;
  els.searchHint.textContent = n
    ? `${n} ${n === 1 ? 'tomo se eleva' : 'tomos se elevan'} de la ronda`
    : 'Ningun tomo responde a ese nombre';
}

function atenuar(tomo, apagar) {
  for (const m of tomo.materiales) {
    m.mat.opacity = apagar ? 0.28 : 1;
    if (m.emisivaBase) {
      m.mat.emissiveIntensity = tomo.resaltado ? m.intensidadBase + 0.55 : m.intensidadBase;
    }
  }
}

/* ---------- Lector ------------------------------------------------------- */

function abrirTomo(nota) {
  els.reader.querySelector('.reader-tome-title').textContent = tituloDe(nota, 120);
  els.reader.querySelector('.reader-author').textContent = nota.autor || 'Viajero anonimo';
  const fecha = els.reader.querySelector('.reader-date');
  fecha.textContent = fechaRelativa(nota.fecha_creacion);
  fecha.title = formatFecha(nota.fecha_creacion);
  els.reader.querySelector('.reader-id').textContent     = `Tomo n.º ${nota.id}`;
  els.reader.querySelector('.reader-text').textContent   = nota.texto || '';

  // Solo el autor puede quemar su propio tomo
  const borrar = els.reader.querySelector('.reader-burn');
  if (esMia(nota)) {
    borrar.hidden = false;
    borrar.textContent = 'Quemar el tomo';
    borrar.classList.remove('is-confirming');
    borrar.onclick = () => confirmarBorrado(nota, borrar);
  } else {
    borrar.hidden = true;
    borrar.onclick = null;
  }

  els.reader.hidden = false;
  sonidoAbrirLibro();
  els.reader.querySelector('.reader-close').focus();
}

function cerrarTomo() {
  if (els.reader.hidden) return;
  els.reader.hidden = true;
  sonidoCerrarLibro();
}

/* Confirmacion en dos pasos dentro del mismo boton, para no sacar al
   lector de la escena con un dialogo del navegador. */
function confirmarBorrado(nota, boton) {
  if (!boton.classList.contains('is-confirming')) {
    boton.classList.add('is-confirming');
    boton.textContent = '¿Seguro? Volve a pulsar';
    setTimeout(() => {
      if (boton.classList.contains('is-confirming')) {
        boton.classList.remove('is-confirming');
        boton.textContent = 'Quemar el tomo';
      }
    }, 4000);
    return;
  }
  borrarNota(nota, boton);
}

async function borrarNota(nota, boton) {
  boton.disabled = true;
  boton.textContent = 'Ardiendo...';
  try {
    const res = await fetch(`/api/notas/${nota.id}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autor: viajero }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'El tomo no pudo quemarse.');
    }
    cerrarTomo();
    els.status.textContent = 'El tomo ardio y ya no esta en la biblioteca.';
    els.status.classList.add('is-good');
    els.status.classList.remove('is-error');
    await cargarNotas();
  } catch (err) {
    boton.textContent = err.message;
    els.status.textContent = err.message;
    els.status.classList.add('is-error');
    els.status.classList.remove('is-good');
  } finally {
    boton.disabled = false;
    boton.classList.remove('is-confirming');
  }
}

els.reader.addEventListener('click', (e) => {
  if (e.target.hasAttribute('data-close')) cerrarTomo();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !els.reader.hidden) cerrarTomo();
});

/* ---------- API ---------------------------------------------------------- */

async function cargarNotas() {
  try {
    const res = await fetch('/api/notas');
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'No se pudo abrir la biblioteca.');
    }
    const nuevas = await res.json();

    const cambio = JSON.stringify(nuevas.map((n) => n.id)) !==
                   JSON.stringify(notas.map((n) => n.id));
    notas = nuevas;

    renderEstanterias();
    if (cambio) construirRonda();
    aplicarBusqueda();

    if (els.status.classList.contains('is-error')) {
      els.status.textContent = '';
      els.status.classList.remove('is-error');
    }
  } catch (err) {
    els.status.textContent = err.message;
    els.status.classList.add('is-error');
    els.status.classList.remove('is-good');
  }
}

els.form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const texto  = els.texto.value.trim();
  const titulo = els.titulo.value.trim();
  if (!texto || !titulo) return;

  try {
    const res = await fetch('/api/notas', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ titulo, texto, autor: viajero }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || 'El tomo no pudo grabarse.');
    }

    els.texto.value = '';
    els.titulo.value = '';
    els.status.textContent = 'El tomo ya descansa en la biblioteca.';
    els.status.classList.add('is-good');
    els.status.classList.remove('is-error');
    sonidoPagina();

    await cargarNotas();
  } catch (err) {
    els.status.textContent = err.message;
    els.status.classList.add('is-error');
    els.status.classList.remove('is-good');
  }
});

els.search.addEventListener('input', aplicarBusqueda);

/* ---------- Dragon: escupe fuego al hacerle click ------------------------ */

const dragonSvg = document.querySelector('.dragon');
const dragonRig = document.querySelector('.dragon-rig');

function soplarFuego() {
  if (!dragonRig || dragonRig.classList.contains('is-breathing')) return;
  dragonRig.classList.add('is-breathing');
  rugido();
  setTimeout(() => dragonRig.classList.remove('is-breathing'), 1100);
}

// Se escucha en el svg entero (no solo en el rectangulo invisible) para que
// tambien cuente el click sobre los pixeles del propio dragon.
if (dragonSvg) {
  dragonSvg.addEventListener('click', soplarFuego);
  dragonSvg.addEventListener('touchstart', (e) => { e.preventDefault(); soplarFuego(); }, { passive: false });
}

/* ---------- Arranque ----------------------------------------------------- */

els.gateForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const nombre = els.gateName.value.trim();
  if (!nombre) return;
  guardarViajero(nombre);
  els.gate.hidden = true;
  arrancar();
});

async function arrancar() {
  try {
    initEscena();
    await cargarModelos();
  } catch (err) {
    console.error('[3d] No se pudieron cargar los modelos:', err);
    els.stageNote.textContent =
      'No se pudo cargar la ronda en 3D. Los tomos siguen disponibles en las estanterias.';
    ring3d.ok = false;
  }
  await cargarNotas();
}

cargarViajero();

if (!viajero) {
  els.gate.hidden = false;
  els.gateName.focus();
} else {
  arrancar();
}

// Refresco periodico: permite ver en vivo que las 2 tasks del frontend
// detras del ALB leen la misma base persistida en EFS.
setInterval(() => {
  if (els.reader.hidden && !els.search.value.trim()) cargarNotas();
}, 5000);
