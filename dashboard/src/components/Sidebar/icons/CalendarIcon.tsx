export function CalendarIcon() {
  const today = new Date();
  const dayName = today.toLocaleDateString('en-US', { weekday: 'short' });
  const dayNum = today.getDate();

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      width: '100%',
      height: '100%',
    }}>
      <span style={{
        fontSize: 14,
        color: '#ff233d',
        fontFamily: 'Inter, Helvetica, sans-serif',
        fontWeight: 400,
        lineHeight: 1,
        marginTop: 2,
      }}>
        {dayName}
      </span>
      <span style={{
        fontSize: 40,
        color: 'black',
        fontFamily: 'Inter, Helvetica, sans-serif',
        fontWeight: 300,
        lineHeight: 1,
        marginTop: -2,
      }}>
        {dayNum}
      </span>
    </div>
  );
}
