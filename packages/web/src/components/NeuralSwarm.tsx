import { useEffect, useRef } from 'react';

type SwarmPhase = 'auto' | 'intro' | 'flock' | 'constellation' | number;

interface SwarmPalette {
  bg: string;
  ink: string;
  accent: string;
  pulse: string;
}

interface NeuralSwarmProps {
  palette?: SwarmPalette;
  density?: number;
  phase?: SwarmPhase;
  className?: string;
  style?: React.CSSProperties;
}

interface Neuron {
  x: number;
  y: number;
  vx: number;
  vy: number;
  size: number;
  phase: number;
  freq: number;
  dendrites: Array<{ angle: number; length: number; curve: number }>;
}

interface Pulse {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  mx: number;
  my: number;
  t: number;
  dur: number;
}

const DEFAULT_PALETTE: SwarmPalette = {
  bg: '#111315',
  ink: '#92969b',
  accent: '#b8a775',
  pulse: '#6d989d',
};

function appendAlpha(hex: string, alpha: number): string {
  const clamped = Math.max(0, Math.min(255, Math.floor(alpha * 255)));
  return `${hex}${clamped.toString(16).padStart(2, '0')}`;
}

function phaseTarget(phase: SwarmPhase, elapsedMs: number, scrollPhase: number): number {
  const timePhase = Math.min(1, elapsedMs / 18_000);
  if (phase === 'auto') return Math.max(timePhase, scrollPhase);
  if (phase === 'intro') return timePhase;
  if (phase === 'flock') return 1;
  if (phase === 'constellation') return 0;
  return typeof phase === 'number' ? phase : timePhase;
}

export function NeuralSwarm({
  palette = DEFAULT_PALETTE,
  density = 1,
  phase = 'auto',
  className,
  style,
}: NeuralSwarmProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const neuronsRef = useRef<Neuron[]>([]);
  const pulsesRef = useRef<Pulse[]>([]);
  const initializedRef = useRef(false);
  const phaseRef = useRef(0);
  const scrollPhaseRef = useRef(0);

  useEffect(() => {
    if (phase !== 'auto') return;

    const updateScrollPhase = () => {
      const canvas = canvasRef.current;
      const container = canvas?.closest('[data-scroll-container]');
      if (container instanceof HTMLElement) {
        const max = container.scrollHeight - container.clientHeight;
        scrollPhaseRef.current = max > 0 ? Math.min(1, container.scrollTop / (max * 0.3)) : 1;
        return;
      }

      const doc = document.documentElement;
      const max = doc.scrollHeight - doc.clientHeight;
      scrollPhaseRef.current = max > 0 ? Math.min(1, window.scrollY / (max * 0.3)) : 0;
    };

    const canvas = canvasRef.current;
    const container = canvas?.closest('[data-scroll-container]');
    if (container instanceof HTMLElement) {
      container.addEventListener('scroll', updateScrollPhase, { passive: true });
    } else {
      window.addEventListener('scroll', updateScrollPhase, { passive: true });
    }
    updateScrollPhase();

    return () => {
      if (container instanceof HTMLElement)
        container.removeEventListener('scroll', updateScrollPhase);
      else window.removeEventListener('scroll', updateScrollPhase);
    };
  }, [phase]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    let animationFrame = 0;
    let running = true;
    let width = 0;
    let height = 0;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = Math.max(1, Math.floor(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      initializedRef.current = false;
    };

    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(canvas);
    const startedAt = performance.now();

    const draw = (timestamp: number) => {
      if (!running) return;
      const elapsed = timestamp - startedAt;
      const target = phaseTarget(phase, elapsed, scrollPhaseRef.current);
      phaseRef.current += (target - phaseRef.current) * 0.02;
      const p = phaseRef.current;

      if (!initializedRef.current) {
        const count = Math.max(16, Math.floor(64 * density));
        neuronsRef.current = Array.from({ length: count }, () => ({
          x: Math.random() * width,
          y: Math.random() * height,
          vx: (Math.random() - 0.5) * 0.08,
          vy: (Math.random() - 0.5) * 0.08,
          size: 1.8 + Math.random() * 2.2,
          phase: Math.random() * Math.PI * 2,
          freq: 0.6 + Math.random() * 0.8,
          dendrites: Array.from({ length: 3 + Math.floor(Math.random() * 3) }, () => ({
            angle: Math.random() * Math.PI * 2,
            length: 6 + Math.random() * 14,
            curve: (Math.random() - 0.5) * 0.8,
          })),
        }));
        pulsesRef.current = [];
        initializedRef.current = true;
      }

      ctx.fillStyle = `${palette.bg}ee`;
      ctx.fillRect(0, 0, width, height);

      const neurons = neuronsRef.current;
      const perception = 110;
      const separation = 26;
      const maxSpeed = 0.35 + 0.65 * p;
      const cohesion = 0.00018 + 0.0012 * p;
      const alignment = 0.008 + 0.028 * p;
      const separationForce = 0.002 + 0.004 * p;

      for (const neuron of neurons) {
        let centerX = 0;
        let centerY = 0;
        let averageVx = 0;
        let averageVy = 0;
        let separationX = 0;
        let separationY = 0;
        let nearby = 0;

        for (const other of neurons) {
          if (other === neuron) continue;
          const dx = other.x - neuron.x;
          const dy = other.y - neuron.y;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared < perception * perception) {
            centerX += other.x;
            centerY += other.y;
            averageVx += other.vx;
            averageVy += other.vy;
            nearby += 1;
            if (distanceSquared < separation * separation) {
              separationX -= dx;
              separationY -= dy;
            }
          }
        }

        if (nearby > 0) {
          centerX = centerX / nearby - neuron.x;
          centerY = centerY / nearby - neuron.y;
          averageVx = averageVx / nearby - neuron.vx;
          averageVy = averageVy / nearby - neuron.vy;
          neuron.vx += centerX * cohesion + averageVx * alignment + separationX * separationForce;
          neuron.vy += centerY * cohesion + averageVy * alignment + separationY * separationForce;
        }

        const noiseScale = 0.04 * (1 - p * 0.7);
        neuron.vx += (width / 2 - neuron.x) * 0.00001 + (Math.random() - 0.5) * noiseScale;
        neuron.vy += (height / 2 - neuron.y) * 0.00001 + (Math.random() - 0.5) * noiseScale;
        const speed = Math.hypot(neuron.vx, neuron.vy);
        if (speed > maxSpeed) {
          neuron.vx = (neuron.vx / speed) * maxSpeed;
          neuron.vy = (neuron.vy / speed) * maxSpeed;
        }
        neuron.x += neuron.vx;
        neuron.y += neuron.vy;
        if (neuron.x < -20) neuron.x = width + 20;
        if (neuron.x > width + 20) neuron.x = -20;
        if (neuron.y < -20) neuron.y = height + 20;
        if (neuron.y > height + 20) neuron.y = -20;
      }

      const connectionRange = 95 + 30 * p;
      ctx.lineCap = 'round';
      for (let i = 0; i < neurons.length; i += 1) {
        const a = neurons[i];
        if (!a) continue;
        for (let j = i + 1; j < neurons.length; j += 1) {
          const b = neurons[j];
          if (!b) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const distance = Math.sqrt(dx * dx + dy * dy);
          if (distance >= connectionRange) continue;

          const strength = 1 - distance / connectionRange;
          const pulseFactor = 0.6 + 0.4 * Math.sin(elapsed * 0.0008 + (i + j) * 0.4);
          const alpha = strength * (0.16 + 0.27 * p) * pulseFactor;
          ctx.strokeStyle = appendAlpha(palette.ink, alpha);
          ctx.lineWidth = 0.4 + strength * 0.5;
          const midX = (a.x + b.x) / 2 + Math.sin(elapsed * 0.0005 + i) * 4;
          const midY = (a.y + b.y) / 2 + Math.cos(elapsed * 0.0005 + j) * 4;
          ctx.beginPath();
          ctx.moveTo(a.x, a.y);
          ctx.quadraticCurveTo(midX, midY, b.x, b.y);
          ctx.stroke();

          if (Math.random() < 0.0004 + 0.002 * p && strength > 0.5) {
            pulsesRef.current.push({
              ax: a.x,
              ay: a.y,
              bx: b.x,
              by: b.y,
              mx: midX,
              my: midY,
              t: 0,
              dur: 50 + Math.random() * 60,
            });
          }
        }
      }

      for (const neuron of neurons) {
        const pulseGlow = 0.7 + 0.3 * Math.sin(elapsed * 0.001 * neuron.freq + neuron.phase);
        ctx.strokeStyle = `${palette.ink}46`;
        ctx.lineWidth = 0.6;
        for (const dendrite of neuron.dendrites) {
          const endX = neuron.x + Math.cos(dendrite.angle) * dendrite.length;
          const endY = neuron.y + Math.sin(dendrite.angle) * dendrite.length;
          const midX = neuron.x + Math.cos(dendrite.angle + dendrite.curve) * dendrite.length * 0.6;
          const midY = neuron.y + Math.sin(dendrite.angle + dendrite.curve) * dendrite.length * 0.6;
          ctx.beginPath();
          ctx.moveTo(neuron.x, neuron.y);
          ctx.quadraticCurveTo(midX, midY, endX, endY);
          ctx.stroke();
        }

        const radius = neuron.size;
        const gradient = ctx.createRadialGradient(
          neuron.x,
          neuron.y,
          0,
          neuron.x,
          neuron.y,
          radius * 6,
        );
        gradient.addColorStop(0, appendAlpha(palette.accent, 0.26 * pulseGlow));
        gradient.addColorStop(1, `${palette.accent}00`);
        ctx.fillStyle = gradient;
        ctx.beginPath();
        ctx.arc(neuron.x, neuron.y, radius * 6, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = palette.ink;
        ctx.beginPath();
        ctx.arc(neuron.x, neuron.y, radius, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = palette.accent;
        ctx.beginPath();
        ctx.arc(neuron.x, neuron.y, radius * 0.5 * pulseGlow, 0, Math.PI * 2);
        ctx.fill();
      }

      const pulses = pulsesRef.current;
      for (let i = pulses.length - 1; i >= 0; i -= 1) {
        const pulse = pulses[i];
        if (!pulse) continue;
        pulse.t += 1;
        if (pulse.t >= pulse.dur) {
          pulses.splice(i, 1);
          continue;
        }
        const u = pulse.t / pulse.dur;
        const x = (1 - u) * (1 - u) * pulse.ax + 2 * (1 - u) * u * pulse.mx + u * u * pulse.bx;
        const y = (1 - u) * (1 - u) * pulse.ay + 2 * (1 - u) * u * pulse.my + u * u * pulse.by;
        const fade = Math.sin(u * Math.PI);
        ctx.fillStyle = palette.pulse;
        ctx.beginPath();
        ctx.arc(x, y, 2.2 * fade, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = `${palette.pulse}30`;
        ctx.beginPath();
        ctx.arc(x, y, 6 * fade, 0, Math.PI * 2);
        ctx.fill();
      }
      if (pulses.length > 80) pulses.splice(0, pulses.length - 80);

      animationFrame = requestAnimationFrame(draw);
    };

    animationFrame = requestAnimationFrame(draw);
    return () => {
      running = false;
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
    };
  }, [density, palette.accent, palette.bg, palette.ink, palette.pulse, phase]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{ display: 'block', width: '100%', height: '100%', ...style }}
    />
  );
}
