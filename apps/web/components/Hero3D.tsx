'use client';

import { useEffect, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float } from '@react-three/drei';

/**
 * The landing-page object only.
 *
 * Constraints that shaped it: it is never mounted on a payment screen, it is
 * loaded with `next/dynamic` so the 3D bundle is not in the first paint, and if
 * WebGL is unavailable (or the user prefers reduced motion) the component returns
 * nothing and the page keeps its static CSS halo. A payment app must not be slower
 * because of a visual.
 */
function Ribbon({ t }: { t: React.RefObject<number> }) {
  const mesh = useRef<HTMLElement>(null);
  useFrame((state) => {
    const m = mesh.current as unknown as { rotation: { x: number; y: number } } | null;
    if (!m) return;
    const time = state.clock.elapsedTime;
    m.rotation.y = time * 0.12;
    m.rotation.x = 0.36 + Math.sin(time * 0.18) * 0.05;
  });
  void t;
  return (
    <group>
      <Float speed={1.1} rotationIntensity={0.28} floatIntensity={0.6}>
        <mesh ref={mesh as never}>
          <torusKnotGeometry args={[1.05, 0.16, 220, 26, 2, 3]} />
          <meshStandardMaterial color="#57e3b4" emissive="#0e2b23" roughness={0.28} metalness={0.72} wireframe={false} />
        </mesh>
        <mesh scale={1.18}>
          <torusKnotGeometry args={[1.05, 0.16, 120, 18, 2, 3]} />
          <meshBasicMaterial color="#f0b25c" wireframe transparent opacity={0.14} />
        </mesh>
      </Float>
      <gridHelper args={[16, 32, '#1d2735', '#141c27']} position={[0, -1.9, 0]} />
    </group>
  );
}

export default function Hero3D({ quality = 'auto' }: { quality?: 'auto' | 'off' }) {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    if (quality === 'off') return;
    try {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      setOk(Boolean(gl) && !reduced);
    } catch {
      setOk(false);
    }
  }, [quality]);

  if (!ok) return null;

  return (
    <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.85]">
      <Canvas
        dpr={[1, 1.5]}
        camera={{ position: [0, 0.4, 4.4], fov: 42 }}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[3, 4, 2]} intensity={1.1} color="#c7f7e4" />
        <pointLight position={[-4, -2, -3]} intensity={0.6} color="#f0b25c" />
        <Ribbon t={{ current: 0 }} />
      </Canvas>
    </div>
  );
}
