import { useState, useEffect } from 'react';
import styles from './RecordingTip.module.css';

const TIP_KEY = 'wfa-recording-tip-shown';

export function RecordingTip() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const shown = sessionStorage.getItem(TIP_KEY);
    if (shown) return;

    setVisible(true);
    sessionStorage.setItem(TIP_KEY, 'true');

    const timer = setTimeout(() => setVisible(false), 5000);
    return () => clearTimeout(timer);
  }, []);

  if (!visible) return null;

  return (
    <div className={styles.tip}>
      <span className={styles.text}>
        Tip: Describe what you're doing as you go — it helps the agent learn faster.
      </span>
      <button className={styles.dismiss} onClick={() => setVisible(false)}>
        &times;
      </button>
    </div>
  );
}
