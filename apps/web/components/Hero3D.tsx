'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Float } from '@react-three/drei';
import * as THREE from 'three';

/**
 * The landing-page hero: a "settlement core" — a luminous mint core with an
 * orbiting ledger ring and drifting payment particles (stablecoin chips that
 * converge toward the core), like money crossing a checkpoint.
 *
 * Constraints that shaped it: it is never mounted on a payment screen, it is
 * loaded with `next/dynamic` so the 3D bundle is not in the first paint, and if
 * WebGL is unavailable (or the user prefers reduced motion) the component
 * returns nothing and the page keeps its static CSS halo.
 *
 * The scene is deliberately calm and premium: deep-abyss background, one mint
 * light source, a warm amber accent, and no camera cuts — money UI, not a game.
 */

const MINT = '#5eead4';
const MINT_SOFT = '#99f6e4';
const AMBER = '#f0b25c';

interface Chip {
  position: [number, number, number];
  drift: number;
  speed: number;
  scale: number;
  asset: 'USDT' | 'USDC' | 'BTC' | 'ETH';
  color: string;
  emissive: string;
}

const CHIP_DEFS = [
  { asset: 'USDT', color: '#2ee6a8', emissive: '#0d3b2c', size: 0.055 },
  { asset: 'USDC', color: '#5b8def', emissive: '#122a5e', size: 0.05 },
  { asset: 'BTC', color: '#f0b25c', emissive: '#4d3110', size: 0.062 },
  { asset: 'ETH', color: '#9aa7ff', emissive: '#222a66', size: 0.052 },
] as const;

function makeChips(seed: number): Chip[] {
  const chips: Chip[] = [];
  let s = seed;
  const rnd = () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
  const defs = CHIP_DEFS;
  for (let i = 0; i < 44; i++) {
    const def = defs[i % defs.length] ?? CHIP_DEFS[0]!;
    const theta = rnd() * Math.PI * 2;
    const radius = 2.1 + rnd() * 2.4;
    chips.push({
      position: [Math.cos(theta) * radius, (rnd() - 0.5) * 2.6, Math.sin(theta) * radius - 0.4],
      drift: rnd() * Math.PI * 2,
      speed: 0.05 + rnd() * 0.09,
      scale: def.size * (0.75 + rnd() * 0.7),
      asset: def.asset,
      color: def.color,
      emissive: def.emissive,
    });
  }
  return chips;
}

function RoundedBox({ color, emissive, size, children }: { color: string; emissive: string; size: number; children?: React.ReactNode }) {
  return (
    <mesh scale={[size, size, size * 0.32]}>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color={color} emissive={emissive} emissiveIntensity={0.55} roughness={0.24} metalness={0.5} />
      {children}
    </mesh>
  );
}

function letterSpacing(text: string): number {
  return (1.15 - text.length * 0.055) * 0.05;
}

/** A single stablecoin chip that slowly swims toward the core. */
function Particle({ chip, time }: { chip: Chip; time: { current: number } }) {
  const ref = useRef<THREE.Group>(null);
  useFrame(() => {
    const g = ref.current;
    if (!g) return;
    const t = time.current ?? 0;
    const angle = chip.drift + t * chip.speed * 0.6;
    const radius = 3.5 - ((t * 0.055) % 2.4);
    const y = Math.sin(angle * 1.7 + chip.drift * 3) * 0.22;
    g.position.set(Math.cos(angle) * radius, y, Math.sin(angle) * radius - 0.4);
    g.rotation.y = t * (0.25 + chip.speed);
    g.rotation.x = Math.sin(t * 0.4 + chip.drift) * 0.08;
  });

  return (
    <group ref={ref} position={chip.position} scale={[chip.scale, chip.scale, chip.scale]}>
      <RoundedBox color={chip.color} emissive={chip.emissive} size={1.35} />
      {/* ticker */}
      <mesh position={[0, 0, 0.2]}>
        <planeGeometry args={[1.22, 0.42]} />
        <meshBasicMaterial color="#04060a" transparent opacity={0.95} />
      </mesh>
      <mesh position={[0, 0, 0.235]}>
        <planeGeometry args={[1.1, 0.18]} />
        <meshBasicMaterial color="#eafff9" transparent opacity={0.9} />
      </mesh>
    </group>
  );
}

/** The central settlement core: glowing torus knot with an orbiting ledger ring. */
function Core({ t }: { t: { current: number } }) {
  const knot = useRef<THREE.Mesh>(null);
  const ring = useRef<THREE.Group>(null);
  const halo = useRef<THREE.Mesh>(null);

  useFrame((state) => {
    const time = state.clock.elapsedTime;
    t.current = time;
    void t;
    if (knot.current) {
      knot.current.rotation.y = time * 0.18;
      knot.current.rotation.x = 0.42 + Math.sin(time * 0.22) * 0.06;
      const s = 1 + Math.sin(time * 0.8) * 0.015;
      knot.current.scale.setScalar(s);
    }
    if (ring.current) {
      ring.current.rotation.z = time * 0.22;
      ring.current.rotation.x = Math.PI / 2 + Math.sin(time * 0.3) * 0.09;
    }
    if (halo.current) {
      const h = halo.current.material as THREE.MeshBasicMaterial;
      h.opacity = 0.16 + Math.sin(time * 1.6) * 0.05;
    }
  });

  return (
    <group>
      <Float speed={1.15} rotationIntensity={0.16} floatIntensity={0.4}>
        <mesh ref={knot}>
          <torusKnotGeometry args={[1.02, 0.3, 190, 26, 2, 3]} />
          <meshStandardMaterial
            color={MINT_SOFT}
            emissive={MINT}
            emissiveIntensity={0.5}
            roughness={0.18}
            metalness={0.86}
            envMapIntensity={1}
          />
        </mesh>
        {/* amber structural echo, offset so the form reads in two materials */}
        <mesh scale={1.16}>
          <torusKnotGeometry args={[1.0, 0.26, 110, 18, 2, 3]} />
          <meshBasicMaterial color={AMBER} wireframe transparent opacity={0.11} />
        </mesh>
      </Float>

      {/* ledger ring: two orbiting beads of light */}
      <group ref={ring}>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[2.05, 0.008, 8, 130]} />
          <meshBasicMaterial color={MINT} transparent opacity={0.55} />
        </mesh>
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <torusGeometry args={[2.28, 0.003, 8, 130]} />
          <meshBasicMaterial color={AMBER} transparent opacity={0.4} />
        </mesh>
        <mesh position={[2.28, 0, 0]}>
          <sphereGeometry args={[0.035, 14, 14]} />
          <meshBasicMaterial color={MINT} />
        </mesh>
        <mesh position={[-2.05, 0, 0]}>
          <sphereGeometry args={[0.03, 14, 14]} />
          <meshBasicMaterial color={AMBER} />
        </mesh>
      </group>
    </group>
  );
}

/** The glowing pool the scene sits on. */
function Halo() {
  const ref = useRef<THREE.Mesh>(null);
  return (
    <mesh ref={ref} rotation={[-Math.PI / 2, 0, 0]} position={[0, -1.92, 0]}>
      <circleGeometry args={[4.2, 64]} />
      <meshBasicMaterial color={MINT} transparent opacity={0.13} />
    </mesh>
  );
}

/** Sparse static stars for depth. */
function Stars() {
  const positions = useMemo(() => {
    const pts: number[] = [];
    let s = 7;
    const rnd = () => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
    for (let i = 0; i < 90; i++) {
      const theta = rnd() * Math.PI * 2;
      const r = 3.6 + rnd() * 4;
      pts.push(Math.cos(theta) * r, (rnd() - 0.5) * 5, Math.sin(theta) * r - 1.4);
    }
    return new Float32Array(pts);
  }, []);
  return (
    <points>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
      </bufferGeometry>
      <pointsMaterial color="#8ff7e2" size={0.02} transparent opacity={0.5} sizeAttenuation />
    </points>
  );
}

export default function Hero3D({ quality = 'auto' }: { quality?: 'auto' | 'off' }) {
  const [ok, setOk] = useState(false);
  const time = useRef(0);
  const chips = useMemo(() => makeChips(12_09_2026), []);

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
    <div aria-hidden className="pointer-events-none absolute inset-0 opacity-[0.92]">
      {/* soft vignette so the scene melts into the page */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_38%,rgba(5,7,10,0.7)_100%)]" />
      <Canvas
        dpr={[1, 1.75]}
        camera={{ position: [0, 0.55, 5.2], fov: 40 }}
        gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
        style={{ position: 'absolute', inset: 0 }}
      >
        <ambientLight intensity={0.5} />
        <directionalLight position={[3, 4, 2]} intensity={1.2} color="#c7f7e4" />
        <directionalLight position={[-3, -1, -2]} intensity={0.5} color={AMBER} />
        <pointLight position={[0, 0, 2.4]} intensity={0.8} color={MINT} />
        <Stars />
        <Core t={time} />
        <Halo />
        {chips.map((c, i) => (
          <Particle key={i} chip={c} time={time} />
        ))}
      </Canvas>
    </div>
  );
}
