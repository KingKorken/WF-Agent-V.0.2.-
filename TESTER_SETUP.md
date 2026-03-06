# Tester Setup Guide

How to connect your local Electron agent to the deployed bridge server and Vercel dashboard.

## Prerequisites

- Node.js 18+
- npm
- The room token assigned to you (a UUID like `a1b2c3d4-e5f6-7890-abcd-ef1234567890`)

## 1. Build the local agent

```bash
git clone <repo-url> && cd WF-Agent-V.0.2.-
npm install
npm run build --workspace=@workflow-agent/shared
npm run build --workspace=@workflow-agent/local-agent
```

## 2. Start the local agent

Set two environment variables and launch:

```bash
WS_URL=wss://wfa-bridge.fly.dev \
ROOM_ID=<your-room-token> \
npm run dev --workspace=@workflow-agent/local-agent
```

Replace `<your-room-token>` with the UUID assigned to you.

You should see:

```
[ws-client] Connected to wss://wfa-bridge.fly.dev
```

The system tray icon will turn green when connected.

## 3. Open the dashboard

Open this URL in your browser (replace the room token):

```
https://<vercel-dashboard-url>?room=<your-room-token>
```

The dashboard should show "Connected" and the agent status should appear.

## 4. Verify the connection

1. The sidebar should show your agent name and supported layers
2. Navigate to the Record tab -- the button should say "Start Recording" (not "Connect local agent to record")
3. Try sending a chat message -- you should get a response

## Troubleshooting

### Dashboard says "Disconnected" or "Connection error"

- Check that `?room=<uuid>` is in the URL
- Verify the bridge server is running: visit `https://wfa-bridge.fly.dev/health`
- Check browser console for WebSocket errors

### Local agent won't connect

- Confirm `WS_URL` uses `wss://` (not `ws://`)
- Confirm `ROOM_ID` matches the UUID in your dashboard URL
- Check that the room token is in the server's `VALID_ROOMS` secret

### "Room ID required" close message

Your room token is not in the server's `VALID_ROOMS` list. Contact the admin to add it.

## Architecture

```
Your Mac                         Cloud
+-----------------+     wss     +-------------------+
| Electron Agent  | ----------> | Bridge Server     |
| (local-agent)   |             | (Fly.io, Frankfurt)|
+-----------------+             +-------------------+
                                       ^
                                       | wss
                                       |
                                +-------------------+
                                | Dashboard         |
                                | (Vercel)          |
                                +-------------------+
```

Both connections use the same room token. The bridge server routes messages only within a room -- testers cannot see each other's sessions.
