/**
 * WebGPU Renderer for zap-engine WASM
 *
 * Reads instance data from WASM memory and renders using GPU instancing.
 * Instance format: [x, y, w, h, u, v, u2, v2, r, g, b, a, layer, ...]
 */

// Instance data layout (floats per instance)
const FLOATS_PER_INSTANCE = 16;

// Shader for rendering textured quads
const SHADER_SOURCE = /* wgsl */ `
struct Uniforms {
  viewProj: mat4x4<f32>,
  atlasSize: vec2<f32>,
  _pad: vec2<f32>,
}

struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) uv: vec2<f32>,
  @location(1) color: vec4<f32>,
  @location(2) @interpolate(flat) layer: u32,
}

@group(0) @binding(0) var<uniform> uniforms: Uniforms;
@group(0) @binding(1) var atlasSampler: sampler;
@group(0) @binding(2) var atlasTextureArray: texture_2d_array<f32>;

// Instance data: x, y, w, h, u, v, u2, v2, r, g, b, a, layer, ...
@group(0) @binding(3) var<storage, read> instances: array<f32>;

// Quad vertices (2 triangles)
const QUAD_VERTS = array<vec2<f32>, 6>(
  vec2<f32>(0.0, 0.0),
  vec2<f32>(1.0, 0.0),
  vec2<f32>(0.0, 1.0),
  vec2<f32>(1.0, 0.0),
  vec2<f32>(1.0, 1.0),
  vec2<f32>(0.0, 1.0),
);

@vertex
fn vs_main(
  @builtin(vertex_index) vertexIndex: u32,
  @builtin(instance_index) instanceIndex: u32
) -> VertexOutput {
  let base = instanceIndex * 16u;

  // Read instance data
  let pos = vec2<f32>(instances[base], instances[base + 1u]);
  let size = vec2<f32>(instances[base + 2u], instances[base + 3u]);
  let uvMin = vec2<f32>(instances[base + 4u], instances[base + 5u]);
  let uvMax = vec2<f32>(instances[base + 6u], instances[base + 7u]);
  let color = vec4<f32>(
    instances[base + 8u],
    instances[base + 9u],
    instances[base + 10u],
    instances[base + 11u]
  );
  let layer = u32(instances[base + 12u]);

  // Get quad vertex
  let quadVert = QUAD_VERTS[vertexIndex];

  // Calculate world position
  let worldPos = pos + quadVert * size;

  // Transform to clip space
  let clipPos = uniforms.viewProj * vec4<f32>(worldPos, 0.0, 1.0);

  // Interpolate UV
  let uv = mix(uvMin, uvMax, quadVert);

  var output: VertexOutput;
  output.position = clipPos;
  output.uv = uv;
  output.color = color;
  output.layer = layer;
  return output;
}

@fragment
fn fs_main(input: VertexOutput) -> @location(0) vec4<f32> {
  let texColor = textureSample(atlasTextureArray, atlasSampler, input.uv, input.layer);
  return texColor * input.color;
}
`;

export interface WebGPURendererConfig {
  canvas: HTMLCanvasElement;
  wasmMemory: WebAssembly.Memory;
  getInstancesPtr: () => number;
  getInstanceCount: () => number;
}

export class WebGPURenderer {
  private device: GPUDevice | null = null;
  private context: GPUCanvasContext | null = null;
  private pipeline: GPURenderPipeline | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private instanceBuffer: GPUBuffer | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private sampler: GPUSampler | null = null;
  private atlasTexture: GPUTexture | null = null;

  private canvas: HTMLCanvasElement;
  private wasmMemory: WebAssembly.Memory;
  private getInstancesPtr: () => number;
  private getInstanceCount: () => number;

  private viewProjMatrix = new Float32Array(16);

  // Camera state
  public cameraX = 0;
  public cameraY = 0;
  public zoom = 1;

  constructor(config: WebGPURendererConfig) {
    this.canvas = config.canvas;
    this.wasmMemory = config.wasmMemory;
    this.getInstancesPtr = config.getInstancesPtr;
    this.getInstanceCount = config.getInstanceCount;
  }

  async init(): Promise<boolean> {
    if (!navigator.gpu) {
      console.error('WebGPU not supported');
      return false;
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      console.error('Failed to get WebGPU adapter');
      return false;
    }

    this.device = await adapter.requestDevice();

    this.context = this.canvas.getContext('webgpu');
    if (!this.context) {
      console.error('Failed to get WebGPU context');
      return false;
    }

    const format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format,
      alphaMode: 'premultiplied',
    });

    // Create shader module
    const shaderModule = this.device.createShaderModule({
      code: SHADER_SOURCE,
    });

    // Create sampler
    this.sampler = this.device.createSampler({
      magFilter: 'nearest',
      minFilter: 'nearest',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
    });

    // Create placeholder atlas texture array (1x1x1 white)
    this.atlasTexture = this.device.createTexture({
      size: [1, 1, 1],
      dimension: '2d',
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    });
    this.device.queue.writeTexture(
      { texture: this.atlasTexture },
      new Uint8Array([255, 255, 255, 255]),
      { bytesPerRow: 4 },
      [1, 1, 1]
    );

    // Create uniform buffer (viewProj + atlasSize)
    this.uniformBuffer = this.device.createBuffer({
      size: 80, // mat4x4 (64) + vec2 (8) + padding (8)
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });

    // Create instance buffer (will be resized as needed)
    const maxInstances = 10000;
    this.instanceBuffer = this.device.createBuffer({
      size: maxInstances * FLOATS_PER_INSTANCE * 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });

    // Create bind group layout
    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d-array' } },
        { binding: 3, visibility: GPUShaderStage.VERTEX, buffer: { type: 'read-only-storage' } },
      ],
    });

    // Create pipeline
    this.pipeline = this.device.createRenderPipeline({
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] }),
      vertex: {
        module: shaderModule,
        entryPoint: 'vs_main',
      },
      fragment: {
        module: shaderModule,
        entryPoint: 'fs_main',
        targets: [{
          format,
          blend: {
            color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha' },
            alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha' },
          },
        }],
      },
      primitive: {
        topology: 'triangle-list',
      },
    });

    // Create bind group
    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.sampler },
        { binding: 2, resource: this.atlasTexture.createView({ dimension: '2d-array' }) },
        { binding: 3, resource: { buffer: this.instanceBuffer } },
      ],
    });

    console.log('WebGPU renderer initialized');
    return true;
  }

  async loadAtlasArray(bitmaps: ImageBitmap[]): Promise<void> {
    if (!this.device || bitmaps.length === 0) return;

    // All bitmaps should be padded to 2048x2048 in WasmGame
    const width = bitmaps[0].width;
    const height = bitmaps[0].height;
    const layers = bitmaps.length;

    // Recreate texture array with correct size
    this.atlasTexture?.destroy();
    this.atlasTexture = this.device.createTexture({
      size: [width, height, layers],
      dimension: '2d',
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    });

    for (let i = 0; i < layers; i++) {
      this.device.queue.copyExternalImageToTexture(
        { source: bitmaps[i] },
        { texture: this.atlasTexture, origin: [0, 0, i] },
        [width, height]
      );
    }

    // Update bind group with new texture array
    const bindGroupLayout = this.pipeline!.getBindGroupLayout(0);
    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer! } },
        { binding: 1, resource: this.sampler! },
        { binding: 2, resource: this.atlasTexture.createView({ dimension: '2d-array' }) },
        { binding: 3, resource: { buffer: this.instanceBuffer! } },
      ],
    });

    console.log(`Atlas array loaded: ${layers} layers of ${width}x${height}`);
  }

  render(): void {
    if (!this.device || !this.context || !this.pipeline || !this.bindGroup) return;

    const width = this.canvas.width;
    const height = this.canvas.height;

    // Update view-projection matrix
    this.updateViewProj(width, height);
    this.device.queue.writeBuffer(this.uniformBuffer!, 0, this.viewProjMatrix);

    // Copy instance data from WASM memory
    const instanceCount = this.getInstanceCount();
    if (instanceCount > 0) {
      const ptr = this.getInstancesPtr();
      const floatCount = instanceCount * FLOATS_PER_INSTANCE;
      const instanceData = new Float32Array(this.wasmMemory.buffer, ptr, floatCount);

      // Debug log (first frame only)
      if (!(this as any)._hasLoggedInstances) {
        console.log(`Rendering ${instanceCount} instances. Buffer size: ${instanceData.length} floats.`);
        console.log("First instance data:", Array.from(instanceData.slice(0, 16)));
        (this as any)._hasLoggedInstances = true;
      }

      this.device.queue.writeBuffer(this.instanceBuffer!, 0, instanceData);
    }

    // Begin render pass
    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();

    const renderPass = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.1, g: 0.1, b: 0.15, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });

    renderPass.setPipeline(this.pipeline);
    renderPass.setBindGroup(0, this.bindGroup);

    if (instanceCount > 0) {
      // 6 vertices per quad (2 triangles)
      renderPass.draw(6, instanceCount);
    }

    renderPass.end();
    this.device.queue.submit([commandEncoder.finish()]);
  }

  private updateViewProj(width: number, height: number): void {
    // Orthographic projection centered on camera
    const left = this.cameraX - (width / 2) / this.zoom;
    const right = this.cameraX + (width / 2) / this.zoom;
    const top = this.cameraY - (height / 2) / this.zoom;
    const bottom = this.cameraY + (height / 2) / this.zoom;

    // Orthographic projection matrix (column-major for WebGPU)
    this.viewProjMatrix[0] = 2 / (right - left);
    this.viewProjMatrix[1] = 0;
    this.viewProjMatrix[2] = 0;
    this.viewProjMatrix[3] = 0;

    this.viewProjMatrix[4] = 0;
    this.viewProjMatrix[5] = 2 / (top - bottom); // Flip Y for screen coords
    this.viewProjMatrix[6] = 0;
    this.viewProjMatrix[7] = 0;

    this.viewProjMatrix[8] = 0;
    this.viewProjMatrix[9] = 0;
    this.viewProjMatrix[10] = 1;
    this.viewProjMatrix[11] = 0;

    this.viewProjMatrix[12] = -(right + left) / (right - left);
    this.viewProjMatrix[13] = -(top + bottom) / (top - bottom);
    this.viewProjMatrix[14] = 0;
    this.viewProjMatrix[15] = 1;
  }

  resize(width: number, height: number): void {
    this.canvas.width = width;
    this.canvas.height = height;
  }

  destroy(): void {
    this.atlasTexture?.destroy();
    this.instanceBuffer?.destroy();
    this.uniformBuffer?.destroy();
    this.device?.destroy();
  }
}
