import { useState, useEffect } from 'react';
import styles from './OnboardingOverlay.module.css';

const ONBOARDING_KEY = 'wfa-onboarding-complete';

const STEPS = [
  {
    title: 'Teach the agent',
    body: 'Record yourself performing a task — payroll, invoicing, data entry. The agent watches and learns your workflow.',
  },
  {
    title: 'Let the agent work',
    body: 'Ask in natural language: "Do my payroll" or "Process this month\'s invoices." The agent executes the workflow you taught it.',
  },
  {
    title: 'Every action is logged',
    body: 'The Logbook records every action for compliance. Generate audit reports with one click — EU and US standards built in.',
  },
];

interface OnboardingOverlayProps {
  forceShow?: boolean;
  onComplete?: () => void;
}

export function OnboardingOverlay({ forceShow = false, onComplete }: OnboardingOverlayProps) {
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (forceShow) {
      setVisible(true);
      setStep(0);
      return;
    }
    const done = localStorage.getItem(ONBOARDING_KEY);
    if (!done) {
      setVisible(true);
    }
  }, [forceShow]);

  const handleNext = () => {
    if (step < STEPS.length - 1) {
      setStep(step + 1);
    } else {
      localStorage.setItem(ONBOARDING_KEY, 'true');
      setVisible(false);
      onComplete?.();
    }
  };

  const handleSkip = () => {
    localStorage.setItem(ONBOARDING_KEY, 'true');
    setVisible(false);
    onComplete?.();
  };

  if (!visible) return null;

  const current = STEPS[step]!;

  return (
    <div className={styles.overlay}>
      <div className={styles.card}>
        <div className={styles.stepIndicator}>
          {STEPS.map((_, i) => (
            <div
              key={i}
              className={styles.dot}
              data-active={i === step ? '' : undefined}
              data-complete={i < step ? '' : undefined}
            />
          ))}
        </div>
        <h2 className={styles.title}>{current.title}</h2>
        <p className={styles.body}>{current.body}</p>
        <div className={styles.actions}>
          <button className={styles.skip} onClick={handleSkip}>
            Skip
          </button>
          <button className={styles.next} onClick={handleNext}>
            {step < STEPS.length - 1 ? 'Next' : 'Get Started'}
          </button>
        </div>
      </div>
    </div>
  );
}
