export function EmailIcon() {
  return (
    <svg viewBox="0 0 54 39" fill="none" style={{ width: 44, height: 32, margin: 'auto' }}>
      <path d="M27 8L54 39H0L27 8Z" fill="url(#emBody)" stroke="white" strokeWidth="0.5" />
      <path d="M0 0L22 17L0 34V0Z" fill="url(#emLeft)" stroke="white" strokeWidth="0.5" />
      <path d="M54 0L32 17L54 34V0Z" fill="url(#emRight)" stroke="white" strokeWidth="0.5" />
      <path d="M0 0L27 22L54 0H0Z" fill="url(#emTop)" />
      <defs>
        <linearGradient id="emBody" x1="27" y1="8" x2="27" y2="39" gradientUnits="userSpaceOnUse">
          <stop stopColor="#D1E5FC" />
          <stop offset="1" stopColor="#7CB3F8" />
        </linearGradient>
        <linearGradient id="emLeft" x1="22" y1="17" x2="0" y2="17" gradientUnits="userSpaceOnUse">
          <stop stopColor="#E1EDFF" />
          <stop offset="1" stopColor="#83BEFC" />
        </linearGradient>
        <linearGradient id="emRight" x1="32" y1="17" x2="54" y2="17" gradientUnits="userSpaceOnUse">
          <stop stopColor="#E1EDFF" />
          <stop offset="1" stopColor="#83BEFC" />
        </linearGradient>
        <linearGradient id="emTop" x1="27" y1="3" x2="27" y2="22" gradientUnits="userSpaceOnUse">
          <stop stopColor="white" />
          <stop offset="1" stopColor="#F7F9FF" />
        </linearGradient>
      </defs>
    </svg>
  );
}
