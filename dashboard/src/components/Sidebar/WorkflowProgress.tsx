import { useEffect, useRef, useCallback } from 'react';
import { useWorkflowStore } from '../../stores/workflowStore';
import type { QueuedWorkflow } from '../../stores/workflowStore';
import styles from './WorkflowProgress.module.css';

type ProgressState = 'idle' | 'running' | 'cancelled_display' | 'fading';

export function WorkflowProgress() {
  const queue = useWorkflowStore((s) => s.queue);
  const executingWorkflow = useWorkflowStore((s) => s.executingWorkflow);
  const cancelledDisplay = useWorkflowStore((s) => s.cancelledDisplay);
  const clearCancelledDisplay = useWorkflowStore((s) => s.clearCancelledDisplay);

  // Refs for trickle animation (bypass React re-renders)
  const fillRef = useRef<HTMLDivElement>(null);
  const trickleRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const displayPercentRef = useRef(0);
  const realPercentRef = useRef(0);
  const totalStepsRef = useRef(0);

  // Refs for timers
  const holdTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // State machine ref
  const stateRef = useRef<ProgressState>('idle');

  // Parse progress from executing workflow
  const parsePercent = useCallback((workflow: QueuedWorkflow | null): number => {
    if (!workflow) return 0;
    const parts = (workflow.progress ?? '0/0').split('/').map(Number);
    const step = parts[0] ?? 0;
    const total = parts[1] ?? 0;
    totalStepsRef.current = total;
    if (total <= 0) return 0;
    return Math.min(100, Math.max(0, Math.round((step / total) * 100)));
  }, []);

  // Update fill bar DOM directly (no React re-render)
  const updateFill = useCallback((percent: number) => {
    displayPercentRef.current = percent;
    if (fillRef.current) {
      fillRef.current.style.transform = `scaleX(${percent / 100})`;
    }
  }, []);

  // Stop trickle interval
  const stopTrickle = useCallback(() => {
    if (trickleRef.current) {
      clearInterval(trickleRef.current);
      trickleRef.current = null;
    }
  }, []);

  // Start trickle interval
  const startTrickle = useCallback(() => {
    stopTrickle();
    trickleRef.current = setInterval(() => {
      const real = realPercentRef.current;
      const totalSteps = totalStepsRef.current;
      if (totalSteps <= 0) return;

      // Calculate trickle target: halfway to the next step
      const stepSize = 100 / totalSteps;
      const nextStep = real + stepSize;
      const trickleTarget = real + stepSize / 2;
      const cap = Math.min(trickleTarget, nextStep - 0.5); // Never reach next step

      const current = displayPercentRef.current;
      if (current < cap) {
        updateFill(Math.min(current + 0.3, cap));
      }
    }, 500);
  }, [stopTrickle, updateFill]);

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      stopTrickle();
      if (holdTimerRef.current) clearTimeout(holdTimerRef.current);
      if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    };
  }, [stopTrickle]);

  // React to executing workflow changes (real progress updates)
  useEffect(() => {
    if (executingWorkflow) {
      const percent = parsePercent(executingWorkflow);
      realPercentRef.current = percent;

      // Snap to real value (CSS transition handles smoothing)
      updateFill(percent);

      if (stateRef.current !== 'running') {
        stateRef.current = 'running';
        // Clear any cancelled display when a new workflow starts
        if (cancelledDisplay) clearCancelledDisplay();
        if (holdTimerRef.current) { clearTimeout(holdTimerRef.current); holdTimerRef.current = null; }
        if (fadeTimerRef.current) { clearTimeout(fadeTimerRef.current); fadeTimerRef.current = null; }
      }

      startTrickle();
    }
  }, [executingWorkflow, parsePercent, updateFill, startTrickle, cancelledDisplay, clearCancelledDisplay]);

  // React to cancelled display
  useEffect(() => {
    if (cancelledDisplay && !executingWorkflow) {
      stateRef.current = 'cancelled_display';
      stopTrickle();
      updateFill(cancelledDisplay.percent);

      // Hold for 2s, then fade
      holdTimerRef.current = setTimeout(() => {
        stateRef.current = 'fading';
        // Force re-render to apply fadeOut class
        fadeTimerRef.current = setTimeout(() => {
          stateRef.current = 'idle';
          clearCancelledDisplay();
        }, 300); // matches CSS fade duration
      }, 2000);
    }
  }, [cancelledDisplay, executingWorkflow, stopTrickle, updateFill, clearCancelledDisplay]);

  // When queue empties and no cancelled display, go idle
  useEffect(() => {
    if (queue.length === 0 && !cancelledDisplay && !executingWorkflow) {
      stateRef.current = 'idle';
      stopTrickle();
    }
  }, [queue.length, cancelledDisplay, executingWorkflow, stopTrickle]);

  // Determine what to show
  const isCancelled = stateRef.current === 'cancelled_display' || stateRef.current === 'fading';
  const showCard = queue.length > 0 || isCancelled;

  if (!showCard) return null;

  // Determine label and percentage for display
  let displayName: string;
  let displayPercent: number;

  if (isCancelled && cancelledDisplay) {
    displayName = `Cancelled — ${cancelledDisplay.name}`;
    displayPercent = cancelledDisplay.percent;
  } else if (executingWorkflow) {
    displayName = executingWorkflow.name;
    displayPercent = parsePercent(executingWorkflow);
  } else if (queue.length > 0 && queue[0]) {
    // Queue has items but nothing executing (paused state after cancel)
    displayName = queue[0].name;
    displayPercent = 0;
  } else {
    return null;
  }

  const isFading = stateRef.current === 'fading';

  return (
    <div
      className={`${styles.card} ${isFading ? styles.fadeOut : ''}`}
      onTransitionEnd={(e) => {
        if (e.propertyName === 'opacity' && isFading) {
          stateRef.current = 'idle';
          clearCancelledDisplay();
        }
      }}
    >
      <div className={styles.header}>
        <span className={styles.title}>{displayName}</span>
        <span className={styles.percentage}>{displayPercent}%</span>
      </div>
      <div className={styles.trackOuter}>
        <div
          ref={fillRef}
          className={styles.trackFill}
          style={{ transform: `scaleX(${displayPercent / 100})` }}
        />
      </div>
    </div>
  );
}
