/**
 * Room configuration — extracts the room token from the URL query string.
 *
 * Testers access the dashboard with ?room=<uuid> so their session is scoped
 * to a specific room on the bridge server. In local dev the room param is
 * optional — the bridge server falls back to a "default" room.
 */

/** UUID v4 pattern for basic validation */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read `?room=<uuid>` from the current URL.
 * Returns the room ID string or `null` when absent / invalid.
 */
export function getRoomId(): string | null {
  const params = new URLSearchParams(window.location.search);
  const room = params.get('room');
  if (!room) return null;
  if (!UUID_RE.test(room)) {
    console.warn('[room] Invalid room token in URL — must be a UUID');
    return null;
  }
  return room;
}

/**
 * True when the dashboard is running on a deployed host AND has no room token.
 * In this case there's no bridge server to connect to (legacy Vercel preview).
 */
export function isCloudPreview(): boolean {
  const host = window.location.hostname;
  const isRemote = host !== 'localhost' && host !== '127.0.0.1' && !host.startsWith('192.168.');
  // On a remote host, we can connect if VITE_WS_URL is set or a room token exists
  if (!isRemote) return false;
  const hasWsUrl = Boolean(import.meta.env.VITE_WS_URL);
  const hasRoom = Boolean(getRoomId());
  return !hasWsUrl && !hasRoom;
}
