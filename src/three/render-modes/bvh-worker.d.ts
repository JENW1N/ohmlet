/**
 * Type shim for the deep worker import — three-mesh-bvh@0.7.8 ships the
 * workers as untyped sources (its index.d.ts comments them out). The runtime
 * shape below matches src/workers/GenerateMeshBVHWorker.js + utils/WorkerBase.js
 * and satisfies three-gpu-pathtracer's `BVHWorker` interface.
 */
declare module 'three-mesh-bvh/src/workers/GenerateMeshBVHWorker.js' {
  import type { BufferGeometry } from 'three'
  import type { MeshBVH, MeshBVHOptions } from 'three-mesh-bvh'

  export class GenerateMeshBVHWorker {
    name: string
    running: boolean
    /** The underlying Worker (null after dispose). */
    worker: Worker | null
    generate(geometry: BufferGeometry, options?: MeshBVHOptions): Promise<MeshBVH>
    dispose(): void
  }
}
