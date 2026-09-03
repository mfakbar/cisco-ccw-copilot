export type ScanPhase = 'connecting' | 'scanning' | 'restoring' | 'preparing' | 'complete' | 'error';

export type ScanProgress = {
  phase: ScanPhase;
  label: string;
  detail?: string;
  current?: number;
  total?: number;
  optionsFound?: number;
};

export interface ScanProgressView {
  current: number;
  total: number;
  found: number;
  activeStep: number;
  eyebrow: string;
  text: string;
  count: string;
  position: string;
  assurance: string;
  indeterminate: boolean;
}

const PHASE_STEP: Record<ScanPhase, number> = { connecting: 0, scanning: 1, restoring: 1, preparing: 2, complete: 3, error: -1 };

export function scanPhaseFromMessage(message: Record<string, unknown>): ScanPhase {
  if (['connecting', 'scanning', 'restoring', 'preparing', 'complete'].includes(String(message.phase))) return message.phase as ScanPhase;
  if (message.label === 'Complete') return 'complete';
  return message.current ? 'scanning' : 'connecting';
}

export function scanProgressView(update: ScanProgress, previousFound = 0): ScanProgressView {
  const current = Math.max(0, Number(update.current) || 0);
  const total = Math.max(0, Number(update.total) || 0);
  const baseline = update.phase === 'connecting' ? 0 : previousFound;
  const found = typeof update.optionsFound === 'number' ? Math.max(0, update.optionsFound) : baseline;
  return {
    current,
    total,
    found,
    activeStep: PHASE_STEP[update.phase],
    eyebrow: update.phase === 'complete' ? 'Scan complete' : update.phase === 'error' ? 'Scan needs attention' : 'Scanning CCW',
    text: update.detail ?? (update.phase === 'scanning' ? 'Reading available components, pricing, and lead times.' : 'Please keep this CCW draft open.'),
    count: `${found} component${found === 1 ? '' : 's'} found`,
    position: update.phase === 'scanning' && total ? `Category ${Math.min(current, total)} of ${total}` : update.phase === 'complete' ? 'Ready to review' : update.phase === 'error' ? 'Not completed' : update.phase === 'restoring' ? 'Almost done' : update.phase === 'preparing' ? 'Final step' : 'Preparing',
    assurance: update.phase === 'complete' ? 'Catalog saved locally. Review each recommendation before applying it.' : update.phase === 'error' ? 'Nothing was applied to the CCW draft. Resolve the issue and scan again.' : 'CCW Copilot will return to the category you started from.',
    indeterminate: update.phase === 'connecting' || update.phase === 'preparing' || update.phase === 'restoring'
  };
}
