import Foundation
import AVFoundation
import Vision
import CoreGraphics

// Entirely local. Classification categories can include objects, settings and
// activities; they describe a sampled still, not an inferred temporal action.
func emit(_ value: [String: Any]) throws {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
    FileHandle.standardOutput.write(Data([10]))
}
struct AnalysisError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}
@main struct VisualVision {
    static func main() async {
        do { try await run() }
        catch { FileHandle.standardError.write(Data("Local visual indexing failed: \(error)\n".utf8)); exit(1) }
    }
    static func run() async throws {
        let args = CommandLine.arguments
        guard (args.count == 5 || args.count == 7), let requestedDuration = Double(args[2]), let interval = Double(args[3]), let sourceStart = Double(args[4]),
            requestedDuration.isFinite, requestedDuration > 0, requestedDuration <= 7200,
            sourceStart.isFinite, sourceStart >= 0, sourceStart <= 86400,
            interval.isFinite, interval >= 1, interval <= 30 else { throw AnalysisError("Expected a local video, duration and sample interval.") }
        let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw AnalysisError("This file has no video track.") }
        let duration = try await track.load(.timeRange).end.seconds
        guard duration.isFinite, duration > 0, abs(duration - sourceStart - requestedDuration) <= 0.25 else {
            throw AnalysisError("The video duration changed. Refresh this asset before indexing.")
        }
        let size = try await track.load(.naturalSize)
        let transform = try await track.load(.preferredTransform)
        let oriented = CGRect(origin: .zero, size: size).applying(transform).standardized
        let total = Int(ceil(requestedDuration / interval - 1e-9))
        guard total > 0, total <= 720 else { throw AnalysisError("Index at most 720 sampled frames per video.") }
        let startIndex = args.count == 7 ? Int(args[5]) ?? -1 : 0
        let endIndex = args.count == 7 ? Int(args[6]) ?? -1 : total
        guard startIndex >= 0, endIndex > startIndex, endIndex <= total else { throw AnalysisError("Invalid visual sample window.") }
        try emit(["type": "header", "duration": requestedDuration, "sourceStart": sourceStart, "width": Int(oriented.width.rounded()),
            "height": Int(oriented.height.rounded()), "sampleInterval": interval, "total": endIndex - startIndex])
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 1280, height: 1280)
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.05, preferredTimescale: 60000)
        for index in startIndex..<endIndex {
            try autoreleasepool {
                // The editor starts source time at its first video PTS, while
                // AVAssetImageGenerator consumes the container presentation clock.
                let decodeTime = sourceStart + Double(index) * interval
                var actualTime = CMTime.invalid
                let image = try generator.copyCGImage(at: CMTime(seconds: decodeTime, preferredTimescale: 1_000_000_000), actualTime: &actualTime)
                let mediaTime = actualTime.seconds
                let time = max(0, mediaTime - sourceStart)
                guard mediaTime.isFinite, mediaTime >= sourceStart - 0.000001, time < requestedDuration else {
                    throw AnalysisError("The decoder returned a frame outside the video source clock.")
                }
                let classify = VNClassifyImageRequest()
                let recognize = VNRecognizeTextRequest()
                recognize.recognitionLevel = .accurate
                recognize.usesLanguageCorrection = false
                recognize.automaticallyDetectsLanguage = true
                recognize.minimumTextHeight = 0.015
                let humans = VNDetectHumanRectanglesRequest()
                humans.upperBodyOnly = false
                try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform([classify, recognize, humans])
                let labels = (classify.results ?? []).filter { $0.confidence >= 0.12 }.sorted { $0.confidence > $1.confidence }.prefix(24).map {
                    ["text": String($0.identifier.prefix(200)), "confidence": Double($0.confidence)] as [String: Any]
                }
                let text = (recognize.results ?? []).compactMap { $0.topCandidates(1).first }
                    .filter { $0.confidence >= 0.3 && !$0.string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }.prefix(40).map {
                        ["text": String($0.string.prefix(240)), "confidence": Double($0.confidence)] as [String: Any]
                    }
                try emit(["type": "sample", "time": time, "mediaTime": mediaTime, "labels": labels, "text": text,
                    "people": min(32, (humans.results ?? []).filter { $0.confidence >= 0.4 }.count)])
            }
        }
        try emit(["type": "done", "completed": endIndex - startIndex])
    }
}
