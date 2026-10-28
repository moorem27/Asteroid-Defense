// Stand-in for three/addons/loaders/GLTFLoader.js: every model is a
// group holding one mesh. The laser beam is exported "centered and
// thin" on purpose, to check that the game normalizes it.

import { Group, Mesh, BufferGeometry, MeshBasicMaterial } from "./fake-three.mjs";

export class GLTFLoader {
    load(url, onLoad, onProgress, onError) {
        setTimeout(() => {
            if (globalThis.__missingModels?.has(url)) {
                onError?.(new Error("404"));
                return;
            }

            const geometry = new BufferGeometry();

            if (url.endsWith("laser_beam.glb")) {
                // Centered on its origin, 0.2 wide, 1 long.
                geometry.box = { min: [-0.1, -0.1, -0.5], max: [0.1, 0.1, 0.5] };
            }

            const mesh = new Mesh(geometry, new MeshBasicMaterial({ color: 0xffffff }));
            const scene = new Group();
            scene.add(mesh);
            scene.name = url;

            onLoad({ scene });
        }, 0);
    }
}
