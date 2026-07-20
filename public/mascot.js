(function exposeMascot(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.OsmosisMascot = api;
})(typeof globalThis === 'undefined' ? null : globalThis, function createMascotApi() {
  'use strict';

  const CELEBRATE_MS = 1_250;
  let active = null;
  let lastCelebrationEpisode = null;
  let threeModule = null;

  function motionReduced(windowRef = globalThis) {
    try {
      return Boolean(windowRef?.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
    } catch {
      return true;
    }
  }

  function canLoadThree({ documentRef = globalThis.document, windowRef = globalThis } = {}) {
    if (!documentRef || documentRef.hidden || motionReduced(windowRef)) return false;
    try {
      const canvas = documentRef.createElement('canvas');
      return Boolean(canvas.getContext('webgl') || canvas.getContext('experimental-webgl'));
    } catch {
      return false;
    }
  }

  function normalizedState(value) {
    return ['idle', 'observing', 'preparing', 'celebrate'].includes(value) ? value : 'idle';
  }

  function fallback(container, state) {
    container.innerHTML = `<div class="mascot-fallback" data-state="${normalizedState(state)}" role="img" aria-label="Osmosis desk buddy"><span class="mascot-fallback-body"></span></div>`;
  }

  function baseState(instance, now) {
    if (instance.requestedState === 'celebrate') {
      return now < instance.celebrateUntil ? 'celebrate' : 'idle';
    }
    return instance.requestedState;
  }

  function stop(instance) {
    if (!instance) return;
    if (instance.frame) instance.windowRef.cancelAnimationFrame?.(instance.frame);
    instance.frame = null;
    instance.renderer?.dispose?.();
    instance.renderer?.domElement?.remove?.();
    instance.cleanup?.();
  }

  async function loadThree() {
    if (!threeModule) {
      threeModule = import('/vendor/three.module.min.js').catch((error) => {
        threeModule = null;
        throw error;
      });
    }
    return threeModule;
  }

  async function startThree(instance) {
    if (!instance.container.isConnected || !canLoadThree({ documentRef: instance.documentRef, windowRef: instance.windowRef })) return;
    let THREE;
    try {
      THREE = await loadThree();
    } catch {
      return;
    }
    if (active !== instance || !instance.container.isConnected || instance.documentRef.hidden || motionReduced(instance.windowRef)) return;
    try {
      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(Math.min(instance.windowRef.devicePixelRatio || 1, 1.5));
      renderer.setSize(44, 44, false);
      renderer.domElement.setAttribute('aria-hidden', 'true');
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(36, 1, .1, 100);
      camera.position.set(0, .25, 4.2);
      const light = new THREE.HemisphereLight(0xfff7ea, 0x257e70, 2.2);
      scene.add(light);
      const robot = new THREE.Group();
      const ink = new THREE.MeshStandardMaterial({ color: 0x26332e, flatShading: true });
      const teal = new THREE.MeshStandardMaterial({ color: 0x257e70, flatShading: true });
      const cream = new THREE.MeshStandardMaterial({ color: 0xfff2dc, flatShading: true });
      const coral = new THREE.MeshStandardMaterial({ color: 0xef7657, flatShading: true });
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.05, .86, .66), teal);
      const head = new THREE.Mesh(new THREE.BoxGeometry(1.17, .78, .72), cream);
      head.position.y = .84;
      const leftEye = new THREE.Mesh(new THREE.SphereGeometry(.075, 6, 5), coral);
      const rightEye = leftEye.clone();
      leftEye.position.set(-.25, .86, .4); rightEye.position.set(.25, .86, .4);
      const leftArm = new THREE.Mesh(new THREE.BoxGeometry(.18, .62, .18), ink);
      const rightArm = leftArm.clone();
      leftArm.position.set(-.65, -.03, 0); rightArm.position.set(.65, -.03, 0);
      robot.add(body, head, leftEye, rightEye, leftArm, rightArm);
      scene.add(robot);
      instance.container.replaceChildren(renderer.domElement);
      instance.renderer = renderer;
      instance.robot = robot;
      instance.leftArm = leftArm;
      instance.rightArm = rightArm;
      const start = instance.windowRef.performance?.now?.() || Date.now();
      const render = (stamp) => {
        if (active !== instance || instance.documentRef.hidden || motionReduced(instance.windowRef)) return;
        const state = baseState(instance, Date.now());
        const elapsed = (stamp - start) / 1_000;
        robot.position.y = state === 'idle' ? Math.sin(elapsed * 2) * .045 : 0;
        leftArm.rotation.z = state === 'observing' ? Math.sin(elapsed * 12) * .45 : state === 'preparing' ? -.35 : 0;
        rightArm.rotation.z = state === 'observing' ? -Math.sin(elapsed * 12) * .45 : state === 'preparing' ? .35 : 0;
        robot.rotation.y = state === 'celebrate' ? elapsed * 8 : state === 'preparing' ? Math.sin(elapsed * 3) * .12 : 0;
        renderer.render(scene, camera);
        instance.frame = instance.windowRef.requestAnimationFrame(render);
      };
      instance.frame = instance.windowRef.requestAnimationFrame(render);
    } catch {
      // The CSS figure was installed before this optional renderer began.
      // Any WebGL issue stays a visual fallback, never a Studio failure.
      fallback(instance.container, baseState(instance, Date.now()));
    }
  }

  function startCelebration(instance, episode) {
    if (episode && episode === lastCelebrationEpisode) {
      instance.celebrateUntil = 0;
      return;
    }
    if (episode) lastCelebrationEpisode = episode;
    instance.celebrateUntil = Date.now() + CELEBRATE_MS;
  }

  function fallbackFromMotion(instance) {
    if (instance.frame) instance.windowRef.cancelAnimationFrame?.(instance.frame);
    instance.frame = null;
    instance.renderer?.dispose?.();
    instance.renderer?.domElement?.remove?.();
    instance.renderer = null;
    fallback(instance.container, baseState(instance, Date.now()));
  }

  function mount(container, { enabled = true, state = 'idle', episode = null, documentRef = globalThis.document, windowRef = globalThis } = {}) {
    if (!container) return null;
    const nextState = normalizedState(state);
    if (active?.container === container) {
      if (active.requestedState !== nextState || (nextState === 'celebrate' && active.episode !== episode)) {
        active.requestedState = nextState;
        active.episode = episode;
        if (nextState === 'celebrate') startCelebration(active, episode);
      }
      return active;
    }
    stop(active);
    const instance = {
      celebrateUntil: 0,
      container,
      documentRef,
      episode,
      frame: null,
      renderer: null,
      requestedState: nextState,
      windowRef,
    };
    if (nextState === 'celebrate') startCelebration(instance, episode);
    active = instance;
    if (enabled !== true) {
      container.replaceChildren();
      return instance;
    }
    fallback(container, nextState);
    if (!canLoadThree({ documentRef, windowRef })) return instance;
    const onVisibility = () => {
      if (documentRef.hidden || motionReduced(windowRef)) {
        fallbackFromMotion(instance);
      }
    };
    documentRef.addEventListener?.('visibilitychange', onVisibility, { passive: true });
    const reducedMedia = windowRef.matchMedia?.('(prefers-reduced-motion: reduce)');
    reducedMedia?.addEventListener?.('change', onVisibility);
    instance.cleanup = () => {
      documentRef.removeEventListener?.('visibilitychange', onVisibility);
      reducedMedia?.removeEventListener?.('change', onVisibility);
    };
    // Let the Studio be interactive first. This optional import remains below
    // the 200 KiB gzip budget and never blocks the card or answer controls.
    windowRef.setTimeout?.(() => void startThree(instance), 0);
    return instance;
  }

  return { CELEBRATE_MS, baseState, canLoadThree, mount, normalizedState, stop: () => stop(active) };
});
