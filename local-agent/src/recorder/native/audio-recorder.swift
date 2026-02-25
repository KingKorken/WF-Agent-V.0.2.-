// audio-recorder.swift
// Records microphone audio to a WAV file using AVAudioRecorder.
// Usage: audio-recorder-darwin <output-path>
//
// Outputs "RECORDING_STARTED" when recording begins.
// Stops cleanly on SIGTERM, outputs "RECORDING_STOPPED".
//
// Compile:
//   swiftc -O -sdk $(xcrun --show-sdk-path) audio-recorder.swift -o ../../bin/audio-recorder-darwin

import AVFoundation

guard CommandLine.arguments.count >= 2 else {
    fputs("Usage: audio-recorder-darwin <output-path>\n", stderr)
    exit(1)
}

let outputPath = CommandLine.arguments[1]
let outputURL = URL(fileURLWithPath: outputPath)

// 16kHz mono PCM WAV — optimal for Whisper transcription
let settings: [String: Any] = [
    AVFormatIDKey: Int(kAudioFormatLinearPCM),
    AVSampleRateKey: 16000.0,
    AVNumberOfChannelsKey: 1,
    AVLinearPCMBitDepthKey: 16,
    AVLinearPCMIsFloatKey: false,
    AVLinearPCMIsBigEndianKey: false,
]

// Request microphone access
let semaphore = DispatchSemaphore(value: 0)
var permissionGranted = false

if #available(macOS 10.14, *) {
    AVCaptureDevice.requestAccess(for: .audio) { granted in
        permissionGranted = granted
        semaphore.signal()
    }
    semaphore.wait()
} else {
    permissionGranted = true
}

guard permissionGranted else {
    fputs("Microphone permission denied\n", stderr)
    exit(1)
}

var recorder: AVAudioRecorder
do {
    recorder = try AVAudioRecorder(url: outputURL, settings: settings)
    recorder.prepareToRecord()
} catch {
    fputs("Failed to create recorder: \(error)\n", stderr)
    exit(1)
}

guard recorder.record() else {
    fputs("Failed to start recording\n", stderr)
    exit(1)
}

print("RECORDING_STARTED")
fflush(stdout)

// Clean shutdown on SIGTERM or SIGINT
func shutdown(_: Int32) {
    recorder.stop()
    print("RECORDING_STOPPED")
    fflush(stdout)
    exit(0)
}

signal(SIGTERM, shutdown)
signal(SIGINT, shutdown)

RunLoop.main.run()
