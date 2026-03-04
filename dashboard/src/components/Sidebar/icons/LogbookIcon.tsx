export function LogbookIcon() {
  return (
    <svg viewBox="0 0 45 35" fill="none" style={{ width: 45, height: 35, margin: 'auto' }}>
      <rect x="0.5" y="3.88" width="44" height="29.46" rx="5.5" fill="url(#lbFill)" stroke="url(#lbStroke)" />
      <rect x="8.25" y="0.25" width="32" height="30" rx="5" fill="url(#lbPage1)" stroke="url(#lbPage1s)" strokeWidth="0.5" />
      <rect x="4.25" y="0.25" width="32" height="30" rx="5" fill="url(#lbPage2)" stroke="url(#lbPage2s)" strokeWidth="0.5" />
      <defs>
        <linearGradient id="lbFill" x1="22.5" y1="3.38" x2="22.5" y2="33.84" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFB569" />
          <stop offset="1" stopColor="#FF8D44" />
        </linearGradient>
        <linearGradient id="lbStroke" x1="1.47" y1="5.84" x2="43.64" y2="32.2" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFEF94" />
          <stop offset="1" stopColor="#FF8933" />
        </linearGradient>
        <linearGradient id="lbPage1" x1="40.82" y1="0.03" x2="23.79" y2="30.72" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFF7" />
          <stop offset="1" stopColor="#FFD2B7" />
        </linearGradient>
        <linearGradient id="lbPage1s" x1="40.71" y1="0" x2="25.56" y2="31.56" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFFA" />
          <stop offset="1" stopColor="#FFDFC1" />
        </linearGradient>
        <linearGradient id="lbPage2" x1="4.18" y1="0" x2="21.21" y2="30.69" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFF7" />
          <stop offset="1" stopColor="#FFD2B7" />
        </linearGradient>
        <linearGradient id="lbPage2s" x1="4.29" y1="0" x2="19.44" y2="31.53" gradientUnits="userSpaceOnUse">
          <stop stopColor="#FFFFFA" />
          <stop offset="1" stopColor="#FFDFC1" />
        </linearGradient>
      </defs>
    </svg>
  );
}
