import { useEffect, useRef } from 'react';

const W = 480;
const H = 160;

// Sign with a finger, stylus or mouse. Gives back a small PNG (or null when cleared) every time a stroke ends.
export default function SignaturePad({ label, value, onChange, disabled }: { label: string; value: string | null | undefined; onChange: (png: string | null) => void; disabled?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const dirty = useRef(false);

  // Shows an existing signature (a saved draft) once, and clears when the value is removed.
  useEffect(() => {
    const c = canvas.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx || dirty.current) return;
    ctx.clearRect(0, 0, W, H);
    if (value) {
      const img = new Image();
      img.onload = () => ctx.drawImage(img, 0, 0, W, H);
      img.src = value;
    }
  }, [value]);

  function point(e: React.PointerEvent<HTMLCanvasElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  }
  function down(e: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    const ctx = e.currentTarget.getContext('2d');
    if (!ctx) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drawing.current = true;
    dirty.current = true;
    const p = point(e);
    ctx.lineWidth = 2.4;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#111';
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.1, p.y + 0.1);
    ctx.stroke();
  }
  function move(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    const ctx = e.currentTarget.getContext('2d');
    if (!ctx) return;
    const p = point(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
  }
  function up(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current) return;
    drawing.current = false;
    onChange(e.currentTarget.toDataURL('image/png'));
  }
  function clear() {
    const ctx = canvas.current?.getContext('2d');
    ctx?.clearRect(0, 0, W, H);
    dirty.current = false;
    onChange(null);
  }

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[13px] font-medium">{label}</span>
        {!disabled && (
          <button type="button" className="ts-lnk text-[13px]" onClick={clear}>
            Clear
          </button>
        )}
      </div>
      <canvas
        ref={canvas}
        width={W}
        height={H}
        aria-label={label}
        className="w-full rounded-ctl border border-dashed border-line2 bg-white touch-none"
        style={{ aspectRatio: `${W} / ${H}`, cursor: disabled ? 'default' : 'crosshair' }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={up}
      />
      <span className="text-xs ts-muted">{value ? 'Signed.' : 'Sign inside the box.'}</span>
    </div>
  );
}
