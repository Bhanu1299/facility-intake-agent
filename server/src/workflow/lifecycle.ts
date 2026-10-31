import type { WorkOrderStatus } from '@fia/shared';

/**
 * Work order lifecycle. Must-ship: proposed -> approved -> dispatched -> accepted (vendor confirms
 * on the dispatch call). A vendor who declines sends it back to approved until the manager
 * approves the next vendor. in_progress / completed are for the stretch vendor view.
 */
export const TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  proposed: ['approved'],
  approved: ['dispatched'],
  dispatched: ['accepted', 'approved'],
  accepted: ['in_progress'],
  in_progress: ['completed'],
  completed: [],
};

export function canTransition(from: WorkOrderStatus, to: WorkOrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class TransitionError extends Error {
  constructor(from: WorkOrderStatus, to: WorkOrderStatus) {
    super(`Cannot move a work order from ${from} to ${to}`);
  }
}

export function assertTransition(from: WorkOrderStatus, to: WorkOrderStatus): void {
  if (!canTransition(from, to)) throw new TransitionError(from, to);
}
