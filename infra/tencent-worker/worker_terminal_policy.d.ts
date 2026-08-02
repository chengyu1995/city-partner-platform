export interface TerminalWorkerJobDescriptor {
  terminalState: string;
  storageStatus: string;
  closureCode: string | null;
  source: string;
}

export const TERMINAL_WORKER_STATUSES: Set<string>;
export function normalizeTerminalWorkerStatus(value: unknown): string | null;
export function getTerminalWorkerJobDescriptor(
  job: Record<string, unknown> | null | undefined
): TerminalWorkerJobDescriptor | null;
export function isTerminalWorkerJob(job: Record<string, unknown> | null | undefined): boolean;
