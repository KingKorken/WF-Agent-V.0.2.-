// event-monitor.swift
// Global input event monitor for macOS.
// Outputs NDJSON to stdout. One JSON object per line.
// Requires Accessibility permission for the parent process (Terminal / Electron).
//
// Compile:
//   swiftc -O -sdk $(xcrun --show-sdk-path) event-monitor.swift -o ../../bin/event-monitor-darwin

import Cocoa
import AppKit

// ---------------------------------------------------------------------------
// Stdout flushing
// ---------------------------------------------------------------------------

func emit(_ dict: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: dict),
          let str = String(data: data, encoding: .utf8) else { return }
    print(str)
    fflush(stdout)
}

// ---------------------------------------------------------------------------
// Timestamp
// ---------------------------------------------------------------------------

func nowMs() -> Int {
    return Int(Date().timeIntervalSince1970 * 1000)
}

// ---------------------------------------------------------------------------
// Screen coordinate helpers
// Cocoa mouse coords are in points with bottom-left origin.
// Convert to top-left origin pixels for consistency with screencapture.
// ---------------------------------------------------------------------------

func screenHeight() -> CGFloat {
    return NSScreen.main?.frame.size.height ?? 0
}

func backingScale() -> CGFloat {
    return NSScreen.main?.backingScaleFactor ?? 2.0
}

func toScreenPixels(point: NSPoint) -> (x: Int, y: Int) {
    let scale = backingScale()
    let flippedY = screenHeight() - point.y
    return (x: Int(point.x * scale), y: Int(flippedY * scale))
}

// ---------------------------------------------------------------------------
// Modifier key extraction
// ---------------------------------------------------------------------------

func modifierNames(from flags: NSEvent.ModifierFlags) -> [String] {
    var mods: [String] = []
    if flags.contains(.command) { mods.append("cmd") }
    if flags.contains(.shift) { mods.append("shift") }
    if flags.contains(.option) { mods.append("opt") }
    if flags.contains(.control) { mods.append("ctrl") }
    return mods
}

// ---------------------------------------------------------------------------
// App tracking for app_switch events
// ---------------------------------------------------------------------------

var previousApp: String = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Unknown"

// ---------------------------------------------------------------------------
// Global event monitors
// ---------------------------------------------------------------------------

// Mouse clicks
NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { event in
    let button = event.type == .leftMouseDown ? "left" : "right"
    let loc = NSEvent.mouseLocation
    let (x, y) = toScreenPixels(point: loc)
    let ts = nowMs()

    if event.type == .leftMouseDown && event.clickCount >= 2 {
        emit(["type": "doubleclick", "x": x, "y": y, "timestamp": ts])
    } else {
        emit(["type": "click", "button": button, "x": x, "y": y, "timestamp": ts])
    }
}

// Key presses
NSEvent.addGlobalMonitorForEvents(matching: .keyDown) { event in
    let ts = nowMs()
    let mods = modifierNames(from: event.modifierFlags)
    let chars = event.characters ?? ""

    // Treat as hotkey if any modifier is held (except shift alone)
    let significantMods = event.modifierFlags.intersection([.command, .control, .option])
    if !significantMods.isEmpty {
        var keys = mods
        if !chars.isEmpty && chars != "\u{0}" {
            keys.append(chars)
        }
        emit(["type": "hotkey", "keys": keys, "timestamp": ts])
    } else {
        let key = chars.isEmpty ? (event.charactersIgnoringModifiers ?? "") : chars
        emit(["type": "keypress", "key": key, "modifiers": mods, "timestamp": ts])
    }
}

// Scroll events
NSEvent.addGlobalMonitorForEvents(matching: .scrollWheel) { event in
    // Only emit for meaningful scroll amounts
    let delta = event.scrollingDeltaY
    guard abs(delta) > 0.5 else { return }
    let loc = NSEvent.mouseLocation
    let (x, y) = toScreenPixels(point: loc)
    emit([
        "type": "scroll",
        "x": x,
        "y": y,
        "deltaY": Int(delta),
        "timestamp": nowMs()
    ])
}

// App switch via NSWorkspace notification
NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.didActivateApplicationNotification,
    object: nil,
    queue: .main
) { notification in
    let newApp = (notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication)?
        .localizedName ?? "Unknown"
    let from = previousApp
    previousApp = newApp
    if from != newApp {
        emit([
            "type": "app_switch",
            "fromApp": from,
            "toApp": newApp,
            "timestamp": nowMs()
        ])
    }
}

// Window focus changes
NSWorkspace.shared.notificationCenter.addObserver(
    forName: NSWorkspace.activeSpaceDidChangeNotification,
    object: nil,
    queue: .main
) { _ in
    guard let app = NSWorkspace.shared.frontmostApplication else { return }
    emit([
        "type": "window_focus",
        "app": app.localizedName ?? "Unknown",
        "title": "",  // title not easily available from NSWorkspace
        "timestamp": nowMs()
    ])
}

// ---------------------------------------------------------------------------
// Clean exit on SIGTERM
// ---------------------------------------------------------------------------

signal(SIGTERM) { _ in exit(0) }
signal(SIGINT)  { _ in exit(0) }

// ---------------------------------------------------------------------------
// Keep alive
// ---------------------------------------------------------------------------

RunLoop.main.run()
