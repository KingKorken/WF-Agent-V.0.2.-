import { useState } from 'react';
import { useLogbookStore } from '../../stores/logbookStore';
import styles from './AuditReportExport.module.css';

export function AuditReportExport() {
  const { isGeneratingReport, setGeneratingReport, getFilteredEntries } = useLogbookStore();
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setError(null);
    setGeneratingReport(true);
    try {
      const entries = getFilteredEntries();
      // TODO: Replace with actual jsPDF generation
      await new Promise((resolve) => setTimeout(resolve, 2000));
      console.log(`Generating audit report for ${entries.length} entries`);
      // Trigger download when real PDF is implemented
    } catch {
      setError('Report generation failed. Please try again.');
    } finally {
      setGeneratingReport(false);
    }
  };

  return (
    <>
      <button
        className={styles.button}
        onClick={handleGenerate}
        disabled={isGeneratingReport}
      >
        {isGeneratingReport ? 'Generating...' : 'Generate Report'}
      </button>
      {error && (
        <span className={styles.error}>{error}</span>
      )}
    </>
  );
}
