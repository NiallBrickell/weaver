import type { ComponentPropsWithoutRef } from 'react';
import { cn } from './utils.js';

export function Card({ className, ...props }: ComponentPropsWithoutRef<'section'>) {
  return (
    <section
      className={cn(
        'rounded-xl border border-zinc-800 bg-zinc-950/70 text-zinc-100 shadow-sm',
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentPropsWithoutRef<'header'>) {
  return <header className={cn('space-y-1.5 p-4', className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentPropsWithoutRef<'h3'>) {
  return <h3 className={cn('font-medium leading-snug tracking-tight', className)} {...props} />;
}

export function CardDescription({ className, ...props }: ComponentPropsWithoutRef<'p'>) {
  return <p className={cn('text-sm leading-5 text-zinc-400', className)} {...props} />;
}

export function CardContent({ className, ...props }: ComponentPropsWithoutRef<'div'>) {
  return <div className={cn('px-4 pb-4', className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentPropsWithoutRef<'footer'>) {
  return (
    <footer
      className={cn('flex items-center gap-2 border-t border-zinc-800 px-4 py-3', className)}
      {...props}
    />
  );
}
