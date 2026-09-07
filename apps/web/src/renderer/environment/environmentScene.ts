import type * as Three from 'three';
import { createDeterministicRng, deterministicBetween } from '../rng';
import {
  advanceEnvironmentCycle2025,
  mapToEnvironmentCycle2025,
  type EnvironmentCycle2025,
} from './cycle2025';
import type { LivingCityQualityCaps } from './qualityCaps';
import { calculateSunLightState, type SunLightState } from './sunLight';
import {
  deriveWeatherUniforms,
  type WeatherSample2025,
  type WeatherUniformState,
} from './weather';

export interface EnvironmentSceneUpdate {
  readonly presentationTime: Date | string | number;
  readonly timeZone: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly weather: WeatherSample2025;
  readonly reducedMotion: boolean;
  readonly meterInWorldUnits: number;
}

export interface EnvironmentSceneState {
  readonly sun: SunLightState;
  readonly weather: WeatherUniformState;
}

export interface EnvironmentSceneController {
  readonly group: Three.Group;
  update: (snapshot: EnvironmentSceneUpdate) => EnvironmentSceneState;
  setPresentationTime: (
    presentationTimeMs: number,
    weather?: WeatherSample2025,
  ) => EnvironmentSceneState | null;
  frame: (deltaMilliseconds: number) => void;
  setWeatherVisible: (visible: boolean) => void;
  dispose: () => void;
}

interface EnvironmentSceneOptions {
  readonly THREE: typeof import('three');
  readonly scene: Three.Scene;
  readonly qualityCaps: LivingCityQualityCaps;
  readonly seed: string;
}

function createParticlePositions(
  count: number,
  seed: string,
): Float32Array {
  const positions = new Float32Array(count * 3);
  const rng = createDeterministicRng(`${seed}:precipitation`);
  for (let index = 0; index < count; index += 1) {
    positions[index * 3] = deterministicBetween(rng, -260, 260);
    positions[index * 3 + 1] = deterministicBetween(rng, -230, 230);
    positions[index * 3 + 2] = deterministicBetween(rng, 3, 115);
  }
  return positions;
}

function wrap(value: number, minimum: number, maximum: number): number {
  const extent = maximum - minimum;
  return ((value - minimum) % extent + extent) % extent + minimum;
}

/**
 * Pure particle placement: the same presentation instant yields identical
 * positions after reload and at every render FPS. Wall-clock frame delta is
 * deliberately absent.
 */
export function calculateWeatherParticlePositions(
  basePositions: Float32Array,
  weather: WeatherUniformState,
  presentationTimeMs: number,
  output = new Float32Array(basePositions.length),
): Float32Array {
  if (output.length !== basePositions.length) {
    throw new RangeError('Particle output length must match base positions');
  }
  const phaseSeconds = wrap(presentationTimeMs / 1_000, 0, 3_600);
  for (let index = 0; index < basePositions.length / 3; index += 1) {
    const offset = index * 3;
    output[offset] = wrap(
      (basePositions[offset] ?? 0) + weather.windEast * phaseSeconds * 0.28,
      -260,
      260,
    );
    output[offset + 1] = wrap(
      (basePositions[offset + 1] ?? 0) - weather.windNorth * phaseSeconds * 0.28,
      -230,
      230,
    );
    output[offset + 2] = wrap(
      (basePositions[offset + 2] ?? 0) - weather.particleSpeedMetersPerSecond * phaseSeconds,
      2,
      115,
    );
  }
  return output;
}

/** Creates only Three-owned objects; the caller retains the shared renderer. */
export function createEnvironmentSceneController(
  options: EnvironmentSceneOptions,
): EnvironmentSceneController {
  const { THREE, scene, qualityCaps } = options;
  const group = new THREE.Group();
  group.name = 'omnitwin-environment';

  const hemisphere = new THREE.HemisphereLight(0xaed5ff, 0x4e5147, 0.8);
  hemisphere.name = 'omnitwin-hemisphere-light';
  group.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xfff0d0, 2.4);
  sun.name = 'omnitwin-sun-light';
  sun.castShadow = qualityCaps.dynamicShadows;
  if (qualityCaps.shadowMapSize > 0) {
    sun.shadow.mapSize.set(qualityCaps.shadowMapSize, qualityCaps.shadowMapSize);
    sun.shadow.camera.near = 20;
    sun.shadow.camera.far = 1_200;
    sun.shadow.camera.left = -260;
    sun.shadow.camera.right = 260;
    sun.shadow.camera.top = 240;
    sun.shadow.camera.bottom = -240;
    sun.shadow.bias = -0.00015;
  }
  sun.target.name = 'omnitwin-sun-target';
  group.add(sun, sun.target);

  const skyUniforms = {
    zenithColor: { value: new THREE.Color(0x275587) },
    horizonColor: { value: new THREE.Color(0x9ebbd1) },
    sunDirection: { value: new THREE.Vector3(0, 0, 1) },
    cloudCover: { value: 0 },
  };
  const skyMaterial = new THREE.ShaderMaterial({
    name: 'omnitwin-sky-material',
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: skyUniforms,
    vertexShader: `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 zenithColor;
      uniform vec3 horizonColor;
      uniform vec3 sunDirection;
      uniform float cloudCover;
      varying vec3 vDirection;
      void main() {
        float heightMix = smoothstep(-0.08, 0.72, vDirection.z);
        float sunGlow = pow(max(dot(normalize(vDirection), normalize(sunDirection)), 0.0), 180.0);
        vec3 sky = mix(horizonColor, zenithColor, heightMix);
        sky = mix(sky, vec3(dot(sky, vec3(0.333))), cloudCover * 0.22);
        sky += vec3(1.0, 0.62, 0.28) * sunGlow * (1.0 - cloudCover * 0.75);
        gl_FragColor = vec4(sky, 1.0);
      }
    `,
  });
  const skyGeometry = new THREE.SphereGeometry(1_100, 24, 12);
  const sky = new THREE.Mesh(skyGeometry, skyMaterial);
  sky.name = 'omnitwin-sky-dome';
  sky.renderOrder = -100;
  sky.frustumCulled = false;
  group.add(sky);

  const maximumParticles = qualityCaps.weatherParticles;
  const basePositions = createParticlePositions(maximumParticles, options.seed);
  const positions = new Float32Array(basePositions);
  const particleGeometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  positionAttribute.setUsage(THREE.DynamicDrawUsage);
  particleGeometry.setAttribute('position', positionAttribute);
  particleGeometry.setDrawRange(0, 0);
  const particleMaterial = new THREE.PointsMaterial({
    name: 'omnitwin-weather-particles',
    color: 0xa9d8ee,
    size: 0.16,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.72,
    depthWrite: false,
  });
  const particles = new THREE.Points(particleGeometry, particleMaterial);
  particles.name = 'omnitwin-precipitation';
  particles.frustumCulled = false;
  group.add(particles);

  const previousFog = scene.fog;
  const fog = new THREE.FogExp2(0x9db0ba, 0);
  scene.fog = fog;
  let currentState: EnvironmentSceneState | null = null;
  let currentSnapshot: EnvironmentSceneUpdate | null = null;
  let anchorCycle: EnvironmentCycle2025 | null = null;
  let currentMeterInWorldUnits = 1;
  let weatherVisible = true;
  let disposed = false;

  const applyCycle = (
    cycle: EnvironmentCycle2025,
    snapshot: EnvironmentSceneUpdate,
  ): EnvironmentSceneState => {
    const sunState = calculateSunLightState(
      cycle,
      snapshot.latitude,
      snapshot.longitude,
      snapshot.weather.cloudCover,
    );
    const weatherState = deriveWeatherUniforms(
      snapshot.weather,
      sunState,
      maximumParticles,
      snapshot.reducedMotion,
    );
    currentMeterInWorldUnits = Math.max(Number.EPSILON, snapshot.meterInWorldUnits);
    currentState = { sun: sunState, weather: weatherState };
    if (weatherState.particleCount > 0) {
      calculateWeatherParticlePositions(basePositions, weatherState, cycle.localPhaseMs, positions);
      positionAttribute.needsUpdate = true;
    }

    const [sunEast, sunNorth, sunUp] = sunState.directionEnu;
    sun.position.set(sunEast * 420, -sunNorth * 420, Math.max(30, sunUp * 420));
    sun.intensity = sunState.directionalIntensity;
    sun.color.setRGB(...sunState.colorLinear);
    hemisphere.intensity = sunState.ambientIntensity;
    hemisphere.color.setRGB(
      weatherState.skyHorizonLinear[0],
      weatherState.skyHorizonLinear[1],
      weatherState.skyHorizonLinear[2],
    );
    hemisphere.groundColor.setRGB(0.22, 0.24, 0.21);
    skyUniforms.zenithColor.value.setRGB(...weatherState.skyZenithLinear);
    skyUniforms.horizonColor.value.setRGB(...weatherState.skyHorizonLinear);
    skyUniforms.sunDirection.value.set(sunEast, -sunNorth, sunUp);
    skyUniforms.cloudCover.value = weatherState.cloudCover;
    fog.color.setRGB(...weatherState.fogColorLinear);
    fog.density = weatherState.fogDensity / currentMeterInWorldUnits;
    particleGeometry.setDrawRange(0, weatherState.particleCount);
    particles.visible = weatherVisible && weatherState.particleCount > 0;
    particleMaterial.color.set(weatherState.mode === 'snow' ? 0xf4f7f8 : 0x9dccdf);
    particleMaterial.opacity = weatherState.mode === 'snow' ? 0.82 : 0.67;
    particleMaterial.size = weatherState.mode === 'snow' ? 0.48 : 0.16;
    return currentState;
  };

  const update = (snapshot: EnvironmentSceneUpdate): EnvironmentSceneState => {
    if (disposed) throw new Error('Environment scene is disposed');
    const cycle = mapToEnvironmentCycle2025(snapshot.presentationTime, snapshot.timeZone);
    currentSnapshot = snapshot;
    anchorCycle = cycle;
    return applyCycle(cycle, snapshot);
  };

  // Motion is driven exclusively by update(presentationTime); render FPS and
  // paused wall time cannot advance environment state.
  const frame = (_deltaMilliseconds: number) => {};

  const setWeatherVisible = (visible: boolean) => {
    weatherVisible = visible;
    particles.visible = weatherVisible && (currentState?.weather.particleCount ?? 0) > 0;
  };

  const setPresentationTime = (
    presentationTimeMs: number,
    weather?: WeatherSample2025,
  ) => {
    if (disposed || !currentSnapshot || !anchorCycle) return null;
    if (weather) currentSnapshot = { ...currentSnapshot, weather };
    return applyCycle(
      advanceEnvironmentCycle2025(anchorCycle, presentationTimeMs),
      currentSnapshot,
    );
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    group.remove(hemisphere, sun, sun.target, sky, particles);
    skyGeometry.dispose();
    skyMaterial.dispose();
    particleGeometry.dispose();
    particleMaterial.dispose();
    if (scene.fog === fog) scene.fog = previousFog;
    currentSnapshot = null;
    anchorCycle = null;
    currentState = null;
  };

  return { group, update, setPresentationTime, frame, setWeatherVisible, dispose };
}
