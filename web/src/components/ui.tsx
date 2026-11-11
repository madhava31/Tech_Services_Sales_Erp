import { forwardRef, useId } from 'react';
import { SearchIcon, XIcon } from 'lucide-react';
import { CountUp } from './ds/CountUp';

function cx(...classes: (string | false | null | undefined)[]) {
  return classes.filter(Boolean).join(' ');
}

// The ERP's small buttons are about 30px high. Field staff use phones one-handed, so they grow to 44px there.
export const PHONE_TOUCH = 'max-[860px]:min-h-11';

type ButtonVariant = 'primary' | 'secondary' | 'danger' | 'ghost';

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: 'ts-dark',
  secondary: 'ts-ghost',
  danger: 'ts-ghost ts-danger-t',
  ghost: '',
};

export const Button = forwardRef<
  HTMLButtonElement,
  React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: 'sm' | 'md' }
>(function Button({ variant = 'primary', size = 'md', className, ...props }, ref) {
  return (
    <button
      ref={ref}
      type="button"
      {...props}
      className={cx('ts-btn justify-center', PHONE_TOUCH, BUTTON_VARIANTS[variant], size === 'sm' && 'ts-xs', className)}
    />
  );
});

function FieldShell({ id, label, hint, children }: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col min-w-0">
      <label htmlFor={id} className="ts-lbl">
        {label}
      </label>
      {children}
      {/* Hints carry instructions, so they use the readable grey rather than the ERP's fainter one. */}
      {hint && <p className="ts-hint !text-subtle mt-1.5">{hint}</p>}
    </div>
  );
}

export const TextField = forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }
>(function TextField({ label, hint, className, ...props }, ref) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint}>
      <input ref={ref} id={id} {...props} className={cx('ts-fi', className)} />
    </FieldShell>
  );
});

export function TextAreaField({
  label,
  hint,
  className,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint}>
      <textarea id={id} rows={3} {...props} className={cx('ts-fi', className)} />
    </FieldShell>
  );
}

export function SelectField({
  label,
  hint,
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: string }) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} hint={hint}>
      <select id={id} {...props} className={cx('ts-fi', className)}>
        {children}
      </select>
    </FieldShell>
  );
}

// Most cards are padded by what's inside them (CardHeader, list rows). A card given its own padding keeps the
// ERP's 20px instead. Set --i in `style` to stagger the entrance.
export function Card({ className, style, children }: { className?: string; style?: React.CSSProperties; children: React.ReactNode }) {
  const padded = /(^|\s)(\w+:)?p-\d/.test(className ?? '');
  return (
    <section style={style} className={cx('ts-card ts-white', !padded && '!p-0', className)}>
      {children}
    </section>
  );
}

export function CardHeader({ title, description, action }: { title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="ts-rhead !items-start !flex-nowrap px-4 sm:px-5 py-4 border-b border-dashed border-line2">
      <div className="min-w-0">
        <h2 className="text-[15px] font-medium">{title}</h2>
        {description && <p className="ts-muted text-[13.5px] mt-0.5">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: 'neutral' | 'brand' | 'ok' | 'muted'; children: React.ReactNode }) {
  const tones = {
    neutral: '',
    brand: 'ts-sent',
    ok: 'ts-tone-good',
    muted: '',
  };
  return <span className={cx('ts-st', tones[tone])}>{children}</span>;
}

// Red everywhere a deal is past its expected closing date.
export function OverdueBadge() {
  return <span className="ts-st ts-tone-bad">Overdue</span>;
}

// Amber: in the same stage too long. Different from overdue, which is about the closing date.
export function StuckBadge({ days }: { days?: number | null }) {
  return <span className="ts-st ts-tone-warn">Stuck{days ? ` ${days} days` : ''}</span>;
}

// The screens space their own notices, so ts-warnbox's bottom margin is dropped.
export function Notice({ tone, children, onDismiss }: { tone: 'error' | 'success'; children: React.ReactNode; onDismiss?: () => void }) {
  return (
    <div role={tone === 'error' ? 'alert' : 'status'} className={cx(tone === 'error' ? 'ts-warnbox !mb-0' : 'ts-okbox')}>
      <span className="min-w-0">{children}</span>
      {onDismiss && (
        <button type="button" onClick={onDismiss} className="grid place-items-center shrink-0 h-11 w-11 -my-3 -mr-3 !no-underline opacity-70 hover:opacity-100" aria-label="Dismiss">
          <XIcon className="size-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: React.ReactNode }) {
  return (
    <header className="ts-phead">
      <div>
        <h1 className="ts-title">{title}</h1>
        {description && <p className="ts-muted mt-1.5">{description}</p>}
      </div>
      {actions && (
        <>
          <span className="ts-grow" />
          <div className="flex flex-wrap gap-2">{actions}</div>
        </>
      )}
    </header>
  );
}

// Sets --i, which staggers a card's entrance.
export function stagger(i: number) {
  return { '--i': i } as React.CSSProperties;
}

// Sets --r, which staggers a table row's entrance.
export function rowStagger(i: number) {
  return { '--r': Math.min(i, 20) } as React.CSSProperties;
}

// Lists are tables on desktop; phones keep rows that don't need sideways scrolling.
export const DESKTOP_ONLY = 'max-[860px]:hidden';
// .ts-list sets its own display, so hiding it needs the important form.
export const PHONE_ONLY = 'min-[861px]:!hidden';

// A figure on a page: label, value, optional note. Numbers count up unless `still` is set, as on printed reports.
export function Tile({ label, value, hint, tone, i, still, className }: { label: string; value: string | number; hint?: string; tone?: 'ok' | 'danger' | 'warn'; i?: number; still?: boolean; className?: string }) {
  const toneClass = tone === 'ok' ? 'text-ok' : tone === 'danger' ? 'text-danger' : tone === 'warn' ? 'text-warn' : '';
  return (
    <div className={cx('ts-card ts-white ts-kpi-sm', className)} style={i === undefined ? undefined : stagger(i)}>
      <div className="ts-ch">{label}</div>
      <div className={cx('ts-val', toneClass)}>
        {typeof value === 'number' && !still ? <CountUp value={value} format={(v) => Math.round(v).toLocaleString('en-IN')} /> : value}
      </div>
      {hint && <div className="ts-hint !text-subtle mt-1">{hint}</div>}
    </div>
  );
}

export function SearchBox({ label, ...props }: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="ts-search max-[860px]:!h-11">
      <SearchIcon className="size-4 shrink-0" aria-hidden="true" />
      <input aria-label={label} {...props} />
    </label>
  );
}

export function LoadingCard() {
  return (
    <Card>
      <SkeletonRows />
    </Card>
  );
}

export function Skeleton({ width = '100%', height = 14 }: { width?: string | number; height?: number }) {
  return <span className="ts-skel block" style={{ width, height }} />;
}

// While a list loads: rows shaped like the content.
export function SkeletonRows({ rows = 4 }: { rows?: number }) {
  return (
    <div className="px-4 sm:px-5 py-4 flex flex-col gap-4" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex flex-col gap-2">
          <Skeleton width="55%" />
          <Skeleton width="35%" height={11} />
        </div>
      ))}
    </div>
  );
}

export function EmptyState({ children }: { children: React.ReactNode }) {
  return <p className="ts-dempty text-center text-subtle !px-5 !py-10">{children}</p>;
}
