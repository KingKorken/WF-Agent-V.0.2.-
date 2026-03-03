import { useState } from 'react';
import { jsPDF } from 'jspdf';
import { useLogbookStore } from '../../stores/logbookStore';
import type { AuditEntry } from '../../stores/logbookStore';
import styles from './AuditReportExport.module.css';

function formatDate(date: Date): string {
  return date.toLocaleDateString('en-GB', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function generatePdf(entries: AuditEntry[]): void {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const margin = 20;
  const contentWidth = pageWidth - margin * 2;
  let y = margin;

  const addNewPageIfNeeded = (requiredSpace: number) => {
    if (y + requiredSpace > doc.internal.pageSize.getHeight() - margin) {
      doc.addPage();
      y = margin;
    }
  };

  // Title
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(18);
  doc.text('WF-Agent Audit Report', margin, y);
  y += 10;

  // Metadata
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Generated: ${formatDate(new Date())} at ${formatTime(new Date())}`, margin, y);
  y += 5;
  doc.text(`Total entries: ${entries.length}`, margin, y);
  y += 5;

  if (entries.length > 0) {
    const earliest = entries[entries.length - 1]!.timestamp;
    const latest = entries[0]!.timestamp;
    doc.text(`Period: ${formatDate(earliest)} — ${formatDate(latest)}`, margin, y);
    y += 5;
  }

  // Divider
  y += 3;
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.3);
  doc.line(margin, y, margin + contentWidth, y);
  y += 8;

  // Executive summary
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Executive Summary', margin, y);
  y += 7;

  const successCount = entries.filter((e) => e.result === 'success').length;
  const failureCount = entries.filter((e) => e.result === 'failure').length;
  const departments = [...new Set(entries.map((e) => e.department))];
  const workflows = [...new Set(entries.map((e) => e.workflowName))];

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(10);
  doc.text(`Successful actions: ${successCount}`, margin, y); y += 5;
  doc.text(`Failed actions: ${failureCount}`, margin, y); y += 5;
  doc.text(`Departments: ${departments.join(', ')}`, margin, y); y += 5;
  doc.text(`Workflows: ${workflows.join(', ')}`, margin, y); y += 10;

  // Entries
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(13);
  doc.text('Audit Trail', margin, y);
  y += 8;

  entries.forEach((entry, index) => {
    addNewPageIfNeeded(45);

    // Entry header
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.text(
      `#${index + 1}  ${formatTime(entry.timestamp)}  ${formatDate(entry.timestamp)}`,
      margin,
      y,
    );
    y += 4.5;

    // Entry fields
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);

    const fields: [string, string][] = [
      ['Action', entry.action],
      ['Entity', `${entry.entityId} (${entry.entityType})`],
      ['Result', entry.result],
      ['User', entry.userId],
      ['Workflow', `${entry.workflowName} (${entry.department})`],
      ['Control Layer', entry.controlLayer],
      ['Justification', entry.justification],
    ];

    if (entry.originalValue !== null) {
      fields.push(['Original Value', entry.originalValue || '(empty)']);
    }
    if (entry.newValue !== null) {
      fields.push(['New Value', entry.newValue]);
    }

    fields.push(['Source', `${entry.source.device} (${entry.source.ip})`]);

    fields.forEach(([label, value]) => {
      addNewPageIfNeeded(5);
      doc.setFont('helvetica', 'bold');
      doc.text(`${label}: `, margin, y);
      const labelWidth = doc.getTextWidth(`${label}: `);
      doc.setFont('helvetica', 'normal');
      // Wrap long values
      const lines = doc.splitTextToSize(value, contentWidth - labelWidth) as string[];
      doc.text(lines, margin + labelWidth, y);
      y += 4.5 * Math.max(lines.length, 1);
    });

    // Entry separator
    y += 2;
    doc.setDrawColor(200, 200, 200);
    doc.setLineWidth(0.1);
    doc.line(margin, y, margin + contentWidth, y);
    y += 5;
  });

  // Footer on every page
  const pageCount = doc.internal.pages.length - 1; // jsPDF uses 1-indexed pages
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8);
    doc.setTextColor(150);
    doc.text(
      `WF-Agent Audit Report — Page ${i} of ${pageCount}`,
      margin,
      doc.internal.pageSize.getHeight() - 10,
    );
    doc.setTextColor(0);
  }

  doc.save(`wf-agent-audit-report-${new Date().toISOString().slice(0, 10)}.pdf`);
}

export function AuditReportExport() {
  const { isGeneratingReport, setGeneratingReport, getFilteredEntries } = useLogbookStore();
  const [error, setError] = useState<string | null>(null);

  const handleGenerate = async () => {
    setError(null);
    setGeneratingReport(true);
    try {
      const entries = getFilteredEntries();
      if (entries.length === 0) {
        setError('No entries to export. Adjust your filters.');
        setGeneratingReport(false);
        return;
      }
      // Small delay so the UI updates to "Generating..." before the sync PDF work
      await new Promise((resolve) => setTimeout(resolve, 50));
      generatePdf(entries);
    } catch {
      setError('Report generation failed. Please try again.');
    } finally {
      setGeneratingReport(false);
    }
  };

  return (
    <div className={styles.wrapper}>
      <button
        className={styles.button}
        onClick={handleGenerate}
        disabled={isGeneratingReport}
      >
        {isGeneratingReport ? 'Generating...' : 'Generate Report'}
      </button>
      {error && <span className={styles.error}>{error}</span>}
    </div>
  );
}
