/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import Foundation
import AVFoundation
import Vision
import CoreGraphics

// A local, read-only video analysis helper. JSON lines let the parent report
// progress and cancel the process without buffering decoded frames in memory.
func emit(_ value: [String: Any]) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data([10]))
}

struct AnalysisError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

func thumbnail(_ image: CGImage) -> [UInt8]? {
    let size = 32
    var pixels = [UInt8](repeating: 0, count: size * size)
    let drawn = pixels.withUnsafeMutableBytes { bytes -> Bool in
        guard let context = CGContext(data: bytes.baseAddress, width: size, height: size,
            bitsPerComponent: 8, bytesPerRow: size, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: 0) else { return false }
        context.interpolationQuality = .low
        context.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
        return true
    }
    return drawn ? pixels : nil
}

// Sampling cannot locate exact cuts. Requiring both a substantial spatial and
// histogram change avoids treating small pans or face movement as shot changes.
func discontinuity(_ previous: [UInt8]?, _ current: [UInt8]?) -> Bool {
    guard let previous, let current, previous.count == current.count else { return false }
    var distance = 0.0
    var before = [Int](repeating: 0, count: 16)
    var after = before
    for (a, b) in zip(previous, current) {
        distance += abs(Double(a) - Double(b)) / 255.0
        before[Int(a) / 16] += 1
        after[Int(b) / 16] += 1
    }
    let histogram = zip(before, after).reduce(0.0) { $0 + Double(abs($1.0 - $1.1)) } / (Double(current.count) * 2)
    return distance / Double(current.count) > 0.20 && histogram > 0.30
}

@main
struct ReframeVision {
    static func main() async {
        do { try await run() }
        catch {
            FileHandle.standardError.write(Data("Local face analysis failed: \(error)\n".utf8))
            exit(1)
        }
    }

    static func run() async throws {
        let args = CommandLine.arguments
        guard (args.count == 5 || args.count == 6), let start = Double(args[2]), let end = Double(args[3]), let interval = Double(args[4]),
            start.isFinite, end.isFinite, interval.isFinite, start >= 0, end > start,
            end - start <= 600, interval >= 0.25, interval <= 5 else {
            throw AnalysisError("Expected a local video path, start/end seconds, and sample interval (0.25–5 seconds).")
        }
        let sourceStart = args.count == 6 ? Double(args[5]) ?? .nan : 0
        guard sourceStart.isFinite, sourceStart >= 0 else { throw AnalysisError("Invalid source video clock.") }
        let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
        let duration = try await asset.load(.duration).seconds - sourceStart
        guard duration.isFinite, duration > 0, start < duration, end <= duration + 0.05 else {
            throw AnalysisError("The requested span is outside this video's duration.")
        }
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw AnalysisError("The source has no decodable video track.")
        }
        let size = try await track.load(.naturalSize)
        let transform = try await track.load(.preferredTransform)
        let oriented = CGRect(origin: .zero, size: size).applying(transform).standardized
        guard oriented.width.isFinite, oriented.height.isFinite, oriented.width > 0, oriented.height > 0 else {
            throw AnalysisError("The source has invalid video dimensions.")
        }
        let total = Int(ceil((min(end, duration) - start) / interval - 1e-9))
        guard total > 0, total <= 1200 else { throw AnalysisError("Analyze at most 1,200 sampled frames at a time.") }
        try emit(["type": "header", "duration": duration, "width": Int(oriented.width.rounded()),
            "height": Int(oriented.height.rounded()), "total": total, "sampleInterval": interval])

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: 960, height: 960)
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = CMTime(seconds: 0.05, preferredTimescale: 60000)
        var previous: [UInt8]?
        for index in 0..<total {
            try autoreleasepool {
                let time = start + Double(index) * interval
                let image = try generator.copyCGImage(at: CMTime(seconds: sourceStart + time, preferredTimescale: 60000), actualTime: nil)
                let request = VNDetectFaceRectanglesRequest()
                try VNImageRequestHandler(cgImage: image, orientation: .up, options: [:]).perform([request])
                let faces = (request.results ?? []).filter { $0.confidence >= 0.3 }.sorted {
                    $0.boundingBox.width * $0.boundingBox.height > $1.boundingBox.width * $1.boundingBox.height
                }.prefix(32).map { face -> [String: Double] in
                    let box = face.boundingBox
                    let x = max(0, min(1, box.minX))
                    let y = max(0, min(1, 1 - box.maxY))
                    return ["x": x, "y": y, "width": max(0, min(1 - x, box.width)),
                        "height": max(0, min(1 - y, box.height)), "confidence": Double(face.confidence)]
                }
                let pixels = thumbnail(image)
                try emit(["type": "sample", "time": time, "faces": faces, "cut": discontinuity(previous, pixels)])
                previous = pixels
            }
        }
        try emit(["type": "done", "completed": total])
    }
}
