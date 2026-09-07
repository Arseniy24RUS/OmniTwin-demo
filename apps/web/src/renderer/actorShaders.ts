import type { ShaderModule } from '@luma.gl/shadertools';
import { PERSON_IMPOSTOR_DIAMETER_CSS_PIXELS, PERSON_IMPOSTOR_ALPHA_FALLOFF } from './actorPhysical';

/** Presentation-only geometry, sharing IconLayer's atlas and native picking attributes. */
export const livingActorUniforms = {
  name: 'omnitwinLivingInterpolation',
  vs: `layout(std140) uniform omnitwinLivingInterpolationUniforms {
    float alpha;
    vec2 cameraRight;
    float actorMode;
  } omnitwinLivingInterpolation;`,
  fs: `layout(std140) uniform omnitwinLivingInterpolationUniforms {
    float alpha;
    vec2 cameraRight;
    float actorMode;
  } omnitwinLivingInterpolation;`,
  defaultUniforms: { alpha: 1, cameraRight: [1, 0], actorMode: 0 },
  uniformTypes: { alpha: 'f32', cameraRight: 'vec2<f32>', actorMode: 'f32' },
} as const satisfies ShaderModule<{
  alpha: number;
  cameraRight: readonly [number, number];
  /** 0 = vehicle; 1 = upright person; 2 = selection ring; 3 = top-view person. */
  actorMode: number;
}>;

// IconLayer 9.3 attribute/varying contract; atlas sampling follows vis.gl's MIT
// IconLayer. Unlike its screen-facing billboard branch, every vertex here has
// its own world Z and projected depth. A bounded distant-person impostor is a
// distinct representation; the near physical body has no pixel-size floor.
export const livingActorVertexShader = `#version 300 es
#define SHADER_NAME omnitwin-physical-actor-vertex-shader
in vec2 positions;
in vec3 instancePositions;
in vec3 instancePositions64Low;
in vec3 instancePreviousPositions;
in vec3 instancePreviousPositions64Low;
in float instanceSizes;
in float instanceWidths;
in float instanceAngles;
in vec4 instanceColors;
in vec3 instancePickingColors;
in vec4 instanceIconFrames;
in float instanceColorModes;
in vec2 instanceOffsets;
out float vColorMode;
out vec4 vColor;
out vec2 vTextureCoords;
out vec2 uv;
out float vImpostorMix;

void main(void) {
  vec3 anchor = mix(instancePreviousPositions, instancePositions, omnitwinLivingInterpolation.alpha);
  vec3 low = mix(instancePreviousPositions64Low, instancePositions64Low, omnitwinLivingInterpolation.alpha);
  geometry.worldPosition = anchor;
  geometry.uv = positions;
  geometry.pickingColor = instancePickingColors;
  uv = positions;
  vImpostorMix = 0.0;
  vec2 iconSize = instanceIconFrames.zw;
  vec2 atlasOffset = positions * iconSize * 0.5 + instanceOffsets;
  vec2 metres = atlasOffset / max(iconSize, vec2(1.0)) * vec2(instanceWidths, instanceSizes);
  vec3 offsetMeters;
  if (omnitwinLivingInterpolation.actorMode > 2.5) {
    // Explicit physical footprint at near-top-down pitch, not an enlarged icon.
    offsetMeters = vec3(positions * vec2(0.28, 0.35), 0.1);
  } else if (omnitwinLivingInterpolation.actorMode > 1.5) {
    // A selection-only ground ring. Its size does not change the actor body.
    offsetMeters = vec3(positions * max(0.8, instanceSizes * 0.55), 0.04);
  } else if (omnitwinLivingInterpolation.actorMode > 0.5) {
    // Cylindrical billboard: rotate only around world Z, anchor opaque feet at
    // ground, and leave head/torso depth to the shared scene depth buffer.
    offsetMeters = vec3(omnitwinLivingInterpolation.cameraRight * metres.x, -metres.y);
  } else {
    // Headings are clockwise degrees from north; atlas front points north.
    vec2 ground = vec2(metres.x, -metres.y);
    float angle = radians(instanceAngles);
    float c = cos(angle);
    float s = sin(angle);
    offsetMeters = vec3(mat2(c, -s, s, c) * ground, 0.0);
  }
  vec3 offsetCommon = project_size(offsetMeters);
  DECKGL_FILTER_SIZE(offsetCommon, geometry);
  gl_Position = project_position_to_clipspace(anchor, low, offsetCommon, geometry.position);
  bool person = omnitwinLivingInterpolation.actorMode > 0.5 && omnitwinLivingInterpolation.actorMode < 1.5;
  bool topView = omnitwinLivingInterpolation.actorMode > 2.5;
  if (person || topView) {
    vec3 lowOffset = topView ? vec3(omnitwinLivingInterpolation.cameraRight * -0.35, 0.1) : vec3(0.0);
    vec3 highOffset = topView ? vec3(omnitwinLivingInterpolation.cameraRight * 0.35, 0.1) : vec3(0.0, 0.0, 1.8);
    vec4 physicalLow = project_position_to_clipspace(anchor, low, project_size(lowOffset));
    vec4 physicalHigh = project_position_to_clipspace(anchor, low, project_size(highOffset));
    vec2 cssViewport = project.viewportSize / project.devicePixelRatio;
    float physicalHeightPixels = length((physicalHigh.xy / physicalHigh.w - physicalLow.xy / physicalLow.w) * cssViewport * 0.5);
    vImpostorMix = 1.0 - smoothstep(3.0, 5.0, physicalHeightPixels);
    vec3 glowCenter = vec3(0.0, 0.0, topView ? 0.1 : 0.9);
    vec4 glowClip = project_position_to_clipspace(anchor, low, project_size(glowCenter));
    // Bounded 8 CSS px quad (~5 px visible core), independent of DPR. Keeps the world-anchor
    // depth; there is no always-on-top or additive full-screen/bloom pass.
    glowClip.xy += positions * ${(PERSON_IMPOSTOR_DIAMETER_CSS_PIXELS / 2).toFixed(1)} * 2.0 / cssViewport * glowClip.w;
    gl_Position = mix(gl_Position, glowClip, vImpostorMix);
  }
  DECKGL_FILTER_GL_POSITION(gl_Position, geometry);
  vTextureCoords = (instanceIconFrames.xy + (positions + 1.0) * 0.5 * iconSize) / icon.iconsTextureDim;
  if (omnitwinLivingInterpolation.actorMode > 2.5) {
    vTextureCoords = (instanceIconFrames.xy + iconSize * 0.5) / icon.iconsTextureDim;
  }
  vColor = instanceColors;
  DECKGL_FILTER_COLOR(vColor, geometry);
  vColorMode = instanceColorModes;
}
`;

export const livingActorFragmentShader = `#version 300 es
#define SHADER_NAME omnitwin-physical-actor-fragment-shader
precision highp float;
uniform sampler2D iconsTexture;
in float vColorMode;
in vec4 vColor;
in vec2 vTextureCoords;
in vec2 uv;
in float vImpostorMix;
out vec4 fragColor;
void main(void) {
  geometry.uv = uv;
  if (omnitwinLivingInterpolation.actorMode > 2.5) {
    if (length(uv) > 1.0 && vImpostorMix < 0.01) discard;
    vec3 shirt = texture(iconsTexture, vTextureCoords).rgb;
    vec3 topView = length(uv) < 0.42 ? vec3(0.76, 0.62, 0.48) : shirt;
    fragColor = vec4(topView, layer.opacity * vColor.a);
  } else if (omnitwinLivingInterpolation.actorMode > 1.5) {
    float distanceFromCenter = length(uv);
    if (distanceFromCenter > 1.0 || distanceFromCenter < 0.84) discard;
    fragColor = vec4(0.21, 0.88, 0.94, 0.9 * layer.opacity);
  } else {
    vec4 texColor = texture(iconsTexture, vTextureCoords);
    float alpha = texColor.a * layer.opacity * vColor.a;
    fragColor = vec4(mix(texColor.rgb, vColor.rgb, vColorMode), alpha);
  }
  if (vImpostorMix > 0.0) {
    float radius = length(uv);
    float glowAlpha = radius > 1.0 ? 0.0 : exp(-${PERSON_IMPOSTOR_ALPHA_FALLOFF.toFixed(1)} * radius * radius);
    vec4 glow = vec4(0.63, 0.97, 1.0, glowAlpha * layer.opacity * vColor.a);
    fragColor = mix(fragColor, glow, vImpostorMix);
  }
  if (fragColor.a < icon.alphaCutoff) discard;
  DECKGL_FILTER_COLOR(fragColor, geometry);
}
`;
