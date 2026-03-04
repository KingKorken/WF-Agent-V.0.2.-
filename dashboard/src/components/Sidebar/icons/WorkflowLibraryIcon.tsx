export function WorkflowLibraryIcon() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      height: '100%',
      gap: 3,
      padding: 12,
    }}>
      {/* Search bar at top */}
      <svg width="37" height="10" viewBox="0 0 37 10" fill="none">
        <rect width="37" height="10" rx="4" fill="url(#searchGrad)" />
        <circle cx="4.5" cy="4.5" r="2.3" stroke="white" strokeWidth="0.4" />
        <line x1="6.14" y1="5.86" x2="8.14" y2="7.86" stroke="white" strokeWidth="0.4" />
        <defs>
          <linearGradient id="searchGrad" x1="18.5" y1="0" x2="18.5" y2="10" gradientUnits="userSpaceOnUse">
            <stop stopColor="#A1A0A2" />
            <stop offset="1" stopColor="#B9B8B8" />
          </linearGradient>
        </defs>
      </svg>
      {/* Color grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 9px)',
        gridTemplateRows: 'repeat(2, 9px)',
        gap: 5,
      }}>
        <div style={{ width: 9, height: 9, borderRadius: 2, background: 'linear-gradient(to bottom, #c13888, #ff48b3)' }} />
        <div style={{ width: 9, height: 9, borderRadius: 2, background: 'linear-gradient(to bottom, #26a0cc, #13c1ff)' }} />
        <div style={{ width: 9, height: 9, borderRadius: 2, background: 'linear-gradient(to bottom, #855699, #b173cc)' }} />
        <div style={{ width: 9, height: 9, borderRadius: 2, background: 'linear-gradient(to bottom, #007151, #00d79a)' }} />
        <div style={{ width: 9, height: 9, borderRadius: 2, background: 'linear-gradient(to bottom, #b5b5b5, #d9d9d9)' }} />
        <div style={{ width: 9, height: 9, borderRadius: 2, background: 'linear-gradient(to bottom, #d07100, #ff8a00)' }} />
      </div>
    </div>
  );
}
