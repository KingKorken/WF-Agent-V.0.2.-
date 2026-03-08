# Tester Setup Guide

Install WFA Agent on your Mac and connect it to the dashboard.

## What You Need

- A Mac (macOS 13 Ventura or later)
- Your room token (a UUID like `a1b2c3d4-e5f6-4890-abcd-ef1234567890`) -- from your setup email
- Your dashboard URL -- from your setup email

## 1. Install the App

1. Download the DMG file from the link in your setup email
2. Open the DMG file
3. Drag "WFA Agent" to your Applications folder
4. Open WFA Agent from Applications

**macOS Security Warning (first time only):**

macOS will block the app because it is not signed. To allow it:

1. Go to **System Settings** > **Privacy & Security**
2. Scroll down -- you will see a message about "WFA Agent" being blocked
3. Click **Open Anyway**
4. Click **Open** in the confirmation dialog

## 2. Enter Your Room Token

On first launch, the setup screen appears:

1. Paste the room token from your setup email
2. Click **Connect**
3. Wait for the connection to confirm

If it says "Connection failed", check that your token is correct and try again.

## 3. Grant macOS Permissions

WFA Agent needs three permissions to record and replay workflows:

| Permission | What it does | How to grant |
|---|---|---|
| **Accessibility** | Controls other apps (clicks, typing) | Click "Grant" -- System Settings opens. Add WFA Agent to the list. |
| **Screen Recording** | Captures screenshots during recording | Click "Grant" -- System Settings opens. Add WFA Agent to the list. |
| **Microphone** | Records your voice narration | A system dialog will appear. Click "Allow". |

**After granting Accessibility and Screen Recording, you must quit and reopen the app.**

These permissions may prompt again monthly on macOS Sequoia -- this is normal macOS behavior.

## 4. Open the Dashboard

Open this URL in your browser (replace with your actual values):

```
https://<vercel-dashboard-url>?room=<your-room-token>
```

The dashboard should show "Connected" with your agent listed.

## 5. Test It

1. Navigate to the **Record** tab
2. Click **Start Recording**
3. Do a short task on your Mac (open an app, type something, close it)
4. Click **Stop Recording**
5. The recording will be parsed into a workflow
6. Try running the workflow from the **Workflows** tab

## Troubleshooting

### App won't open

- Go to System Settings > Privacy & Security > scroll down > click "Open Anyway"
- On macOS Sequoia 15+, right-click > Open no longer works for unsigned apps

### Dashboard shows "Disconnected"

- Make sure the agent is running (check your menu bar for the WFA Agent icon)
- Check that `?room=<uuid>` is in your dashboard URL
- Try quitting and relaunching the agent from Applications

### Recording doesn't capture events

- Check that Accessibility permission is granted (System Settings > Privacy & Security > Accessibility)
- Quit and reopen the app after granting the permission

### No audio in recording

- Check that Microphone permission is granted
- The microphone prompt only appears once -- if you denied it, go to System Settings > Privacy & Security > Microphone and enable WFA Agent

### Bridge server is down

Visit `https://wfa-bridge.fly.dev/health` in your browser. It should show `{"status":"ok"}`. If not, contact the admin.

## Architecture

```
Your Mac                         Cloud
+-----------------+     wss     +-------------------+
| WFA Agent       | ----------> | Bridge Server     |
| (menu bar app)  |             | (Fly.io, Frankfurt)|
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

## Need Help?

Reply to your setup email or reach out to the team on Slack.
