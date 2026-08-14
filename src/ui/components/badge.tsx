import type { ComponentPropsWithoutRef } from 'react';
import { cn } from './utils.js';

const variantClasses = {
  neutral: 'border-zinc-700 bg-zinc-900 text-zinc-300',
  accent: 'border-violet-500/30 bg-violet-500/10 text-violet-300',
  attention: 'border-rose-500/30 bg-rose-500/10 text-rose-300',
  success: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
  warning: 'border-amber-500/30 bg-amber-500/10 text-amber-300',
  outline: 'border-zinc-700 bg-transparent text-zinc-400',
} as const;

export type BadgeVariant = keyof typeof variantClasses;

export interface BadgeProps extends ComponentPropsWithoutRef<'span'> {
  variant?: BadgeVariant;
}

export function Badge({ className, variant = 'neutral', ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium leading-5',
        variantClasses[variant],
        className,
      )}
      {...props}
    />
  );
}
