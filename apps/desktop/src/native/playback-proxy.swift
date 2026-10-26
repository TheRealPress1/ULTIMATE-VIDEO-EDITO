import Foundation
import AVFoundation
import CoreImage
import CoreVideo
import CoreMedia
import VideoToolbox
import Darwin

// Video-only playback derivative. Audio, source geometry and all offline
// exports stay attached to the original file in the editor.
struct ProxyError: Error, CustomStringConvertible {
    let description: String
    init(_ text: String) { description = text }
}
func emit(_ value: [String: Any]) throws {
    FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]))
    FileHandle.standardOutput.write(Data([10]))
}
@main struct PlaybackProxy {
    static func main() async {
        do { try await run() }
        catch { FileHandle.standardError.write(Data("Playback optimization failed: \(error)\n".utf8)); exit(1) }
    }
    static func run() async throws {
        let args = CommandLine.arguments
        let parent = getppid()
        guard args.count == 5, let expectedStart = Double(args[3]), let expectedDuration = Double(args[4]),
            expectedStart.isFinite, expectedStart >= 0, expectedStart <= 86400,
            expectedDuration.isFinite, expectedDuration > 0, expectedDuration <= 28800 else {
            throw ProxyError("Expected source, destination, source start and content duration.")
        }
        guard !FileManager.default.fileExists(atPath: args[2]) else { throw ProxyError("The derivative output already exists.") }
        let asset = AVURLAsset(url: URL(fileURLWithPath: args[1]))
        guard let track = try await asset.loadTracks(withMediaType: .video).first else { throw ProxyError("This source has no video track.") }
        let naturalSize = try await track.load(.naturalSize)
        let transform = try await track.load(.preferredTransform)
        let range = try await track.load(.timeRange)
        let segments = try await track.load(.segments)
        let contentSegments = segments.filter { !$0.isEmpty }
        guard let contentStart = contentSegments.first?.timeMapping.target.start,
            segments.allSatisfy({ !$0.isEmpty || CMTimeCompare($0.timeMapping.target.end, contentStart) <= 0 }) else {
            throw ProxyError("This source's internal video gaps use original playback.")
        }
        let nominal = Double(try await track.load(.nominalFrameRate))
        let oriented = CGRect(origin: .zero, size: naturalSize).applying(transform).standardized
        guard oriented.width.isFinite, oriented.height.isFinite, oriented.width >= 2, oriented.height >= 2,
            oriented.width <= 32768, oriented.height <= 32768 else { throw ProxyError("Unsupported video dimensions.") }
        let factor = min(1, 1280 / max(oriented.width, oriented.height), 720 / min(oriented.width, oriented.height))
        let width = max(2, Int((oriented.width * factor / 2).rounded(.down)) * 2)
        let height = max(2, Int((oriented.height * factor / 2).rounded(.down)) * 2)
        let fps = nominal.isFinite && nominal > 0 ? nominal : 30
        guard fps <= 240 else { throw ProxyError("This high-frame-rate source uses original playback.") }

        // H.264 proxies are SDR. Preserve HDR sources by declining optimization
        // instead of silently displaying a washed-out or clipped derivative.
        let descriptions = try await track.load(.formatDescriptions)
        for description in descriptions {
            if let transfer = CMFormatDescriptionGetExtension(description, extensionKey: kCMFormatDescriptionExtension_TransferFunction) as? String,
                transfer.contains("2084") || transfer.contains("2100") || transfer.lowercased().contains("hlg") {
                throw ProxyError("HDR footage keeps original playback to preserve its appearance.")
            }
            if let primaries = CMFormatDescriptionGetExtension(description, extensionKey: kCMFormatDescriptionExtension_ColorPrimaries) as? String,
                primaries.lowercased().contains("p3") || primaries.contains("2020") {
                throw ProxyError("Wide-gamut footage keeps original playback to preserve its appearance.")
            }
        }
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw ProxyError("This source cannot be decoded locally.") }
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? ProxyError("Could not start video decoding.") }
        // AVAssetReader synthesizes a black image at the beginning of an MP4
        // empty edit-list segment. It is not a source packet: skip that leading
        // gap so the derivative starts at the editor's first real frame.
        var firstFrame: CMSampleBuffer?
        var emptyEdits = 0
        while let sample = output.copyNextSampleBuffer() {
            if CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(sample), contentStart) >= 0,
                CMSampleBufferGetImageBuffer(sample) != nil { firstFrame = sample; break }
            emptyEdits += 1
            guard emptyEdits < 4096 else { throw ProxyError("Unsupported video edit list.") }
        }
        guard let first = firstFrame else { throw reader.error ?? ProxyError("The video contains no decodable frames.") }
        let firstPTS = CMSampleBufferGetPresentationTimeStamp(first)
        let sourceStart = firstPTS.seconds
        let duration = CMTimeSubtract(range.end, firstPTS).seconds
        guard sourceStart.isFinite, abs(sourceStart - expectedStart) <= 0.001,
            duration.isFinite, duration > 0, abs(duration - expectedDuration) <= max(0.05, 1 / fps) else {
            throw ProxyError("The source video clock changed. Continue using the original.")
        }
        let writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: args[2]), fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoEncoderSpecificationKey: [kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder as String: true],
            AVVideoWidthKey: width, AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [
                AVVideoAverageBitRateKey: 2_500_000,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                AVVideoExpectedSourceFrameRateKey: fps,
                AVVideoMaxKeyFrameIntervalDurationKey: 0.5,
                AVVideoAllowFrameReorderingKey: false,
            ],
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ])
        input.expectsMediaDataInRealTime = false
        input.mediaTimeScale = max(60_000, try await track.load(.naturalTimeScale))
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width, kCVPixelBufferHeightKey as String: height,
            kCVPixelBufferIOSurfacePropertiesKey as String: [:],
        ])
        guard writer.canAdd(input) else { throw ProxyError("The local H.264 encoder is unavailable.") }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? ProxyError("Could not start the local encoder.") }
        writer.startSession(atSourceTime: .zero)
        // Decoder BGRA already has the SDR RGB values used by WebCodecs.
        // Core Image's default transfer conversion brightens them a second
        // time; preserve those values while resizing the playback derivative.
        let context = CIContext(options: [.cacheIntermediates: false, .workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
        // Track matrices use top-left coordinates; Core Image uses bottom-left.
        // Conjugate the linear transform by a vertical flip, then normalize its
        // translated bounds. Applying the track matrix directly reverses 90°.
        let imageTransform = CGAffineTransform(a: transform.a, b: -transform.b, c: -transform.c, d: transform.d, tx: 0, ty: 0)
        let bounds = CGRect(x: 0, y: 0, width: width, height: height)
        var frames = 0
        var previous = -Double.infinity
        var lastProgress = Date.distantPast
        func append(_ sample: CMSampleBuffer) throws {
            try autoreleasepool {
                let time = CMTimeSubtract(CMSampleBufferGetPresentationTimeStamp(sample), firstPTS)
                guard time.seconds.isFinite, time.seconds >= 0, time.seconds > previous,
                    time.seconds < duration + 0.001, let pixels = CMSampleBufferGetImageBuffer(sample) else {
                    throw ProxyError("The video contains unsupported presentation timing.")
                }
                while !input.isReadyForMoreMediaData {
                    guard getppid() == parent else { throw ProxyError("The editor closed.") }
                    guard writer.status == .writing else { throw writer.error ?? ProxyError("The proxy encoder stopped.") }
                    Thread.sleep(forTimeInterval: 0.002)
                }
                guard let pool = adaptor.pixelBufferPool else { throw ProxyError("The encoder could not allocate playback buffers.") }
                var buffer: CVPixelBuffer?
                guard CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &buffer) == kCVReturnSuccess,
                    let buffer else { throw ProxyError("Insufficient memory for playback optimization.") }
                var image = CIImage(cvPixelBuffer: pixels, options: [.colorSpace: NSNull()]).transformed(by: imageTransform)
                image = image.transformed(by: CGAffineTransform(translationX: -image.extent.minX, y: -image.extent.minY))
                image = image.transformed(by: CGAffineTransform(scaleX: CGFloat(width) / image.extent.width, y: CGFloat(height) / image.extent.height))
                context.render(image, to: buffer, bounds: bounds, colorSpace: nil)
                CVBufferSetAttachment(buffer, kCVImageBufferColorPrimariesKey, kCVImageBufferColorPrimaries_ITU_R_709_2, .shouldPropagate)
                CVBufferSetAttachment(buffer, kCVImageBufferTransferFunctionKey, kCVImageBufferTransferFunction_ITU_R_709_2, .shouldPropagate)
                CVBufferSetAttachment(buffer, kCVImageBufferYCbCrMatrixKey, kCVImageBufferYCbCrMatrix_ITU_R_709_2, .shouldPropagate)
                guard adaptor.append(buffer, withPresentationTime: time) else { throw writer.error ?? ProxyError("Could not encode a playback frame.") }
                previous = time.seconds; frames += 1
                if Date().timeIntervalSince(lastProgress) >= 1 {
                    guard getppid() == parent else { throw ProxyError("The editor closed.") }
                    try emit(["type": "progress", "completed": min(duration, time.seconds), "total": duration])
                    lastProgress = Date()
                }
            }
        }
        try append(first)
        while let sample = output.copyNextSampleBuffer() { try append(sample) }
        guard reader.status == .completed else { throw reader.error ?? ProxyError("Source decoding did not finish.") }
        writer.endSession(atSourceTime: CMTimeSubtract(range.end, firstPTS))
        input.markAsFinished()
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error ?? ProxyError("Playback optimization did not finish.") }

        // Reopen the completed derivative to establish the clock consumed by
        // playback, rather than assuming the encoder's container timestamps.
        let proxy = AVURLAsset(url: URL(fileURLWithPath: args[2]))
        guard let proxyTrack = try await proxy.loadTracks(withMediaType: .video).first,
            try await proxy.loadTracks(withMediaType: .audio).isEmpty else { throw ProxyError("Invalid playback derivative tracks.") }
        let proxyRange = try await proxyTrack.load(.timeRange)
        let verify = try AVAssetReader(asset: proxy)
        let verifyOutput = AVAssetReaderTrackOutput(track: proxyTrack, outputSettings: nil)
        verify.add(verifyOutput)
        guard verify.startReading(), let packet = verifyOutput.copyNextSampleBuffer() else { throw ProxyError("The playback derivative cannot be reopened.") }
        let proxyStart = CMSampleBufferGetPresentationTimeStamp(packet).seconds
        verify.cancelReading()
        guard proxyStart.isFinite, abs(proxyStart) <= 0.001,
            abs(proxyRange.end.seconds - proxyStart - duration) <= max(0.002, 1 / fps) else {
            throw ProxyError("Playback derivative timing did not match the source.")
        }
        try emit(["type": "done", "sourceStart": sourceStart, "proxyStart": proxyStart, "duration": duration,
            "width": width, "height": height, "sourceWidth": Int(oriented.width.rounded()), "sourceHeight": Int(oriented.height.rounded()),
            "frameRate": fps, "frames": frames])
    }
}
