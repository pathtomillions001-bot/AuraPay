import type { ReactNode } from 'react';
import { Dot, SimulatedTag } from './ui';

export interface BackendStep {
  step?: number;
  label?: string;
  state?: string;
  status?: string;
  at?: string | null;
  simulated?: boolean;
}

/**
 * Renders the settlement steps the *server* reported, in the server's order.
 *
 * There is no local timer here and no optimistic advance: a step turns green only
 * when `status` says so. If the request fails mid-flight the strip stops where the
 * truth stops, which is the whole point of the screen.
 */
export function Stepper({ steps, status, simulated }: { steps: BackendStep[]; status?: string; simulated?: boolean }) {
  if (!steps?.length) return null;
  const activeIndex = steps.findIndex((s) => s.status === 'active' || s.status === 'processing' || s.status === 'pending');
  return (
    <ol className="flex flex-col gap-0">
      {steps.map((s, i) => {
        const done = s.status === 'completed';
        const failed = s.status === 'failed';
        const active = i === activeIndex;
        return (
          <li key={`${s.step ?? i}-${s.state}`} className="flex gap-3">
            <div className="flex flex-col items-center">
              <span className="mt-[7px] grid h-3.5 w-3.5 place-items-center">
                {done ? (
                  <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 text-mint" aria-hidden>
                    <circle cx="8" cy="8" r="7" fill="currentColor" opacity="0.16" />
                    <path d="M4.6 8.4l2.1 2.1 4.4-4.8" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
                  </svg>
                ) : failed ? (
                  <span className="h-3.5 w-3.5 rounded-full bg-rose/25 ring-1 ring-rose" />
                ) : (
                  <Dot tone={active ? 'ok' : 'idle'} pulse={active} />
                )}
              </span>
              {i < steps.length - 1 ? <span className={`w-px flex-1 ${done ? 'bg-mint/35' : 'bg-hair'}`} /> : null}
            </div>
            <div className="pb-3.5 pt-[3px]">
              <div className={`text-[13px] ${done ? 'text-ink' : failed ? 'text-rose' : active ? 'text-ink' : 'text-ink-faint'}`}>
                {s.label ?? s.state}
                {(s.simulated ?? simulated) ? <SimulatedTag /> : null}
              </div>
              <div className="text-[11px] text-ink-faint">
                {s.at ? new Date(s.at).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'medium' }) : status === 'FAILED' ? 'not reached' : 'waiting for the network'}
              </div>
            </div>
          </li>
        );
      })}
    </ol>
  );
}

export function ProgressNote({ children }: { children: ReactNode }) {
  return <p className="text-[12px] leading-relaxed text-ink-dim">{children}</p>;
}
