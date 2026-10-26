// Build-only regression fixture. No network, user footage, or extra media tools.
import Foundation
import AVFoundation
import CoreVideo

@main struct Fixture {
    static func main() async throws {
        let output = URL(fileURLWithPath: CommandLine.arguments[1])
        let writer = try AVAssetWriter(outputURL: output, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [AVVideoCodecKey: AVVideoCodecType.h264, AVVideoWidthKey: 128, AVVideoHeightKey: 64])
        input.transform = CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 64, ty: 0)
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA, kCVPixelBufferWidthKey as String: 128, kCVPixelBufferHeightKey as String: 64])
        writer.add(input)
        guard writer.startWriting() else { throw writer.error! }
        writer.startSession(atSourceTime: .zero)
        // Nonzero first PTS, VFR intervals, and a cut between the .5s samples.
        for (index, time) in [2.0, 2.12, 2.24, 2.38, 2.61, 2.8, 3.05, 3.25, 3.5, 3.75].enumerated() {
            while !input.isReadyForMoreMediaData { try await Task.sleep(nanoseconds: 1_000_000) }
            var pixel: CVPixelBuffer?
            CVPixelBufferCreate(kCFAllocatorDefault, 128, 64, kCVPixelFormatType_32BGRA, nil, &pixel)
            guard let pixel else { throw NSError(domain: "fixture", code: 1) }
            CVPixelBufferLockBaseAddress(pixel, [])
            let data = CVPixelBufferGetBaseAddress(pixel)!.assumingMemoryBound(to: UInt8.self), stride = CVPixelBufferGetBytesPerRow(pixel)
            for y in 0..<64 { for x in 0..<128 { let p=y*stride+x*4; let v:UInt8=index<3 ? 15:235; data[p]=v;data[p+1]=v;data[p+2]=v;data[p+3]=255 } }
            CVPixelBufferUnlockBaseAddress(pixel, [])
            guard adaptor.append(pixel, withPresentationTime: CMTime(seconds: time, preferredTimescale: 60000)) else { throw writer.error! }
        }
        input.markAsFinished()
        writer.endSession(atSourceTime: CMTime(seconds: 4, preferredTimescale: 60000))
        await writer.finishWriting()
        guard writer.status == .completed else { throw writer.error! }
    }
}
