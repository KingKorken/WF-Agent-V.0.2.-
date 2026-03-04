import styles from './CalendarView.module.css';

const CALENDAR_SERVICES = [
  { id: 'apple', name: 'Apple Calendar', description: 'Sync with your iCloud calendar' },
  { id: 'outlook', name: 'Outlook Calendar', description: 'Connect your Microsoft 365 calendar' },
  { id: 'google', name: 'Google Calendar', description: 'Link your Google Workspace calendar' },
];

export function CalendarView() {
  return (
    <div className={styles.root}>
      <div className={styles.centered}>
        <h2 className={styles.title}>Calendar</h2>
        <p className={styles.subtitle}>
          Connect your calendar to let the agent schedule workflows and view upcoming events.
        </p>
        <div className={styles.services}>
          {CALENDAR_SERVICES.map((service) => (
            <button key={service.id} className={styles.serviceCard} type="button">
              <span className={styles.serviceName}>{service.name}</span>
              <span className={styles.serviceDesc}>{service.description}</span>
              <span className={styles.connectLabel}>Connect</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
