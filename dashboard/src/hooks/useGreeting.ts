export function useGreeting(name: string = 'there'): string {
  const hour = new Date().getHours();
  if (hour < 12) return `Good morning, ${name}. Ready to get things done?`;
  if (hour < 17) return `Good afternoon, ${name}.`;
  return `Good evening, ${name}. Wrapping up for the day?`;
}
