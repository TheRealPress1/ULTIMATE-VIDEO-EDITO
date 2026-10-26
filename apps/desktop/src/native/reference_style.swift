import Foundation
import AVFoundation
import Vision
import CoreGraphics

struct ReferenceFailure: Error, CustomStringConvertible { let description: String; init(_ s: String) { description=s } }
func emit(_ value: [String:Any]) throws { FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]));FileHandle.standardOutput.write(Data([10])) }
struct Pixels { let values:[UInt8];let histogram:[Double];let palette:[String] }
func pixels(_ image:CGImage) throws -> Pixels {
    var data=[UInt8](repeating:0,count:32*32*4)
    let drawn=data.withUnsafeMutableBytes { bytes -> Bool in
        guard let context=CGContext(data:bytes.baseAddress,width:32,height:32,bitsPerComponent:8,bytesPerRow:128,space:CGColorSpaceCreateDeviceRGB(),bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        context.interpolationQuality = .low;context.draw(image,in:CGRect(x:0,y:0,width:32,height:32));return true
    }
    guard drawn else { throw ReferenceFailure("Cannot inspect reference pixels.") }
    var hist=[Double](repeating:0,count:64)
    for i in stride(from:0,to:data.count,by:4) { let key=(Int(data[i])/64)*16+(Int(data[i+1])/64)*4+Int(data[i+2])/64;hist[key]+=1/1024 }
    let palette=hist.enumerated().filter{$0.element>0}.sorted{$0.element>$1.element}.prefix(3).map { entry in
        let key=entry.offset;return String(format:"#%02x%02x%02x",(key/16)*64+32,((key/4)%4)*64+32,(key%4)*64+32)
    }
    return Pixels(values:data,histogram:hist,palette:palette)
}
func change(_ a:Pixels,_ b:Pixels)->Double {
    var histogram=0.0;for i in 0..<64 { histogram+=abs(a.histogram[i]-b.histogram[i])/2 }
    var difference=0.0;for i in stride(from:0,to:a.values.count,by:4) { for c in 0..<3 { difference+=Double(abs(Int(a.values[i+c])-Int(b.values[i+c])))/(1024*3*255) } }
    return min(1,0.65*histogram+0.35*difference)
}
@main struct ReferenceStyle {
    static func main() async { do {try await run()}catch{FileHandle.standardError.write(Data("Reference analysis failed: \(error)\n".utf8));exit(1)} }
    static func run() async throws {
        let args=CommandLine.arguments
        guard args.count==4,let duration=Double(args[2]),let sourceStart=Double(args[3]),duration.isFinite,duration>0,duration<=86400,sourceStart.isFinite,sourceStart>=0,sourceStart<=86400 else {throw ReferenceFailure("Expected local reference, duration, and video track origin.")}
        let asset=AVURLAsset(url:URL(fileURLWithPath:args[1]))
        guard let track=try await asset.loadTracks(withMediaType:.video).first else {throw ReferenceFailure("Reference has no video track.")}
        let end=try await track.load(.timeRange).end.seconds
        guard abs(end-sourceStart-duration)<=0.25 else {throw ReferenceFailure("The reference duration changed. Refresh the imported file.")}
        let size=try await track.load(.naturalSize), transform=try await track.load(.preferredTransform)
        let oriented=CGRect(origin:.zero,size:size).applying(transform).standardized
        let analyzed=min(duration,120),interval=0.25,total=Int(ceil(analyzed/interval-1e-9))
        let generator=AVAssetImageGenerator(asset:asset);generator.appliesPreferredTrackTransform=true;generator.maximumSize=CGSize(width:1280,height:1280)
        generator.requestedTimeToleranceBefore = .zero;generator.requestedTimeToleranceAfter=CMTime(seconds:0.1,preferredTimescale:60000)
        var samples=[[String:Any]](),previous:Pixels?=nil
        for index in 0..<total {
            try autoreleasepool {
                var actual=CMTime.invalid
                let image=try generator.copyCGImage(at:CMTime(seconds:sourceStart+Double(index)*interval,preferredTimescale:1_000_000_000),actualTime:&actual)
                let mediaTime=actual.seconds,time=max(0,mediaTime-sourceStart)
                guard mediaTime.isFinite,time<analyzed,abs(time-Double(index)*interval)<interval else {throw ReferenceFailure("Reference decoder returned an unexpected timestamp. Use a video with at least four frames per second.")}
                let frame=try pixels(image),score=previous.map{change($0,frame)} ?? 0
                var text=[[String:Any]]()
                if index%4==0 {
                    let request=VNRecognizeTextRequest();request.recognitionLevel = .accurate;request.usesLanguageCorrection=false;request.automaticallyDetectsLanguage=true;request.minimumTextHeight=0.012
                    try VNImageRequestHandler(cgImage:image,orientation:.up,options:[:]).perform([request])
                    text=(request.results ?? []).compactMap { result -> [String:Any]? in
                        guard let candidate=result.topCandidates(1).first,candidate.confidence>=0.3,!candidate.string.trimmingCharacters(in:.whitespacesAndNewlines).isEmpty else{return nil}
                        let box=result.boundingBox
                        return ["text":String(candidate.string.prefix(240)),"confidence":Double(candidate.confidence),"x":Double(box.minX),"y":Double(1-box.maxY),"width":Double(box.width),"height":Double(box.height)]
                    }.prefix(40).map{$0}
                }
                samples.append(["time":time,"mediaTime":mediaTime,"change":score,"text":text,"palette":frame.palette]);previous=frame
                try emit(["type":"progress","completed":index+1,"total":total])
            }
        }
        try emit(["type":"result","analysis":["duration":duration,"sourceStart":sourceStart,"analyzedDuration":analyzed,"width":Int(oriented.width.rounded()),"height":Int(oriented.height.rounded()),"sampleInterval":interval,"samples":samples]])
    }
}
