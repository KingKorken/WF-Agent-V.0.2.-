import { useState } from 'react';
import styles from './EmailView.module.css';

interface EmailService {
  id: string;
  name: string;
  description: string;
}

const EMAIL_SERVICES: EmailService[] = [
  { id: 'outlook', name: 'Microsoft Outlook', description: 'Connect your Outlook or Microsoft 365 email' },
  { id: 'gmail', name: 'Google Gmail', description: 'Connect your Google Workspace or personal Gmail' },
  { id: 'apple', name: 'Apple Mail (iCloud)', description: 'Connect your iCloud email account' },
];

export function EmailView() {
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connected, setConnected] = useState<Set<string>>(new Set());

  const handleConnect = (serviceId: string) => {
    setConnecting(serviceId);
    // Simulate OAuth flow — in production this would open an OAuth popup
    setTimeout(() => {
      setConnected((prev) => new Set(prev).add(serviceId));
      setConnecting(null);
    }, 1500);
  };

  return (
    <div className={styles.root}>
      <div className={styles.centered}>
        <h2 className={styles.title}>Email</h2>
        <p className={styles.subtitle}>
          Connect your email account so the agent can read, organize, and draft emails as part of your workflows.
        </p>
        <div className={styles.services}>
          {EMAIL_SERVICES.map((service) => {
            const isConnected = connected.has(service.id);
            const isConnecting = connecting === service.id;

            return (
              <button
                key={service.id}
                className={`${styles.serviceCard} ${isConnected ? styles.serviceCardConnected : ''}`}
                type="button"
                disabled={isConnecting}
                onClick={() => !isConnected && handleConnect(service.id)}
              >
                <span className={styles.serviceName}>{service.name}</span>
                <span className={styles.serviceDesc}>{service.description}</span>
                <span className={isConnected ? styles.connectedLabel : styles.connectLabel}>
                  {isConnecting ? 'Connecting...' : isConnected ? 'Connected' : 'Connect'}
                </span>
              </button>
            );
          })}
        </div>
        <p className={styles.note}>
          Your credentials are stored locally and never sent to our servers.
          The agent accesses email only when executing a workflow you have approved.
        </p>
      </div>
    </div>
  );
}
