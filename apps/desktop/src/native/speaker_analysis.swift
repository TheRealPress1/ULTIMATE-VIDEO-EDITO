import Foundation
import AVFoundation
import Vision
import CoreImage
import CoreML
import Accelerate
import Darwin

struct SpeakerError: Error, CustomStringConvertible { let description: String; init(_ message: String) { description = message } }
func emit(_ value: [String: Any]) throws { FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])); FileHandle.standardOutput.write(Data([10])) }
struct FaceBox { var id: Int; var x: Double; var y: Double; var w: Double; var h: Double; var confidence: Double }
struct FrameEvidence { var time: Double; var cut: Bool; var boxes: [FaceBox] }
func overlap(_ a: FaceBox, _ b: FaceBox) -> Double { let w = max(0, min(a.x+a.w,b.x+b.w)-max(a.x,b.x)); let h = max(0,min(a.y+a.h,b.y+b.h)-max(a.y,b.y)); return w*h/max(1e-10,a.w*a.h+b.w*b.h-w*h) }
// Vision can extend a detected face slightly outside the displayed image.
// Keep that padded geometry for model crops, but expose valid in-frame bounds.
func displayBox(_ b: FaceBox) -> FaceBox? {
    let x=max(0,b.x),y=max(0,b.y),right=min(1,b.x+b.w),bottom=min(1,b.y+b.h)
    guard right>x,bottom>y else{return nil}
    return FaceBox(id:b.id,x:x,y:y,w:right-x,h:bottom-y,confidence:b.confidence)
}
func thumbnail(_ image: CGImage, size: Int = 32) -> [UInt8] {
    var bytes = [UInt8](repeating: 0, count: size*size)
    bytes.withUnsafeMutableBytes { raw in if let c = CGContext(data: raw.baseAddress,width:size,height:size,bitsPerComponent:8,bytesPerRow:size,space:CGColorSpaceCreateDeviceGray(),bitmapInfo:0) { c.draw(image,in:CGRect(x:0,y:0,width:size,height:size)) } }; return bytes
}
func isCut(_ a: [UInt8]?, _ b: [UInt8]) -> Bool { guard let a else { return false }; var difference = 0.0; var h1 = [Int](repeating:0,count:16), h2=h1; for (x,y) in zip(a,b) { difference += abs(Double(x)-Double(y))/255;h1[Int(x)/16]+=1;h2[Int(y)/16]+=1 }; let hd = zip(h1,h2).reduce(0.0){$0+Double(abs($1.0-$1.1))}/Double(a.count*2); return difference/Double(a.count)>0.20 && hd>0.25 }

// Matches Light-ASD demo: pad around the square face, expand by0.4, resize to
//224 then retain its center112. This is equivalent to drawing the center half.
func faceCrop(_ image: CGImage, _ face: FaceBox) -> [UInt8] {
    let iw=Double(image.width), ih=Double(image.height), bs=max(face.w*iw,face.h*ih)/2
    let mx=(face.x+face.w/2)*iw, my=(face.y+face.h/2)*ih
    let expanded=bs*2.8, left=mx-bs*1.4+expanded*0.25, top=my-bs+expanded*0.25, side=expanded*0.5
    var bytes=[UInt8](repeating:110,count:112*112)
    bytes.withUnsafeMutableBytes { raw in
        guard let c=CGContext(data:raw.baseAddress,width:112,height:112,bitsPerComponent:8,bytesPerRow:112,space:CGColorSpaceCreateDeviceGray(),bitmapInfo:0) else{return}
        c.setFillColor(gray:110.0/255,alpha:1);c.fill(CGRect(x:0,y:0,width:112,height:112));c.interpolationQuality = .high
        // CGImage draw uses bottom-left coordinates; input detections are top-left.
        let scale=112/max(1,side)
        c.draw(image,in:CGRect(x:-left*scale,y:-(ih-top-side)*scale,width:iw*scale,height:ih*scale))
    };return bytes
}

func mfcc(_ pcm: [Float], offset: Int, count: Int = 200) throws -> [Float] {
    // python_speech_features defaults:16kHz,int16 amplitude,400-sample rectangular
    //window,160-sample hop,512FFT,26mel filters,13DCT,lifter22,log-energyC0.
    guard let fft=vDSP_DFT_zop_CreateSetup(nil,512,.FORWARD) else {throw SpeakerError("Cannot prepare audio features.")};defer{vDSP_DFT_DestroySetup(fft)}
    var filters=[[Double]](repeating:[Double](repeating:0,count:257),count:26)
    let highMel=2595*log10(1+8000.0/700), bins=(0..<28).map{Int(floor(513*(700*(pow(10,Double($0)*highMel/27/2595)-1))/16000))}
    for m in 0..<26 {for k in bins[m]..<bins[m+1] where k<257 {filters[m][k]=Double(k-bins[m])/Double(max(1,bins[m+1]-bins[m]))};for k in bins[m+1]..<bins[m+2] where k<257 {filters[m][k]=Double(bins[m+2]-k)/Double(max(1,bins[m+2]-bins[m+1]))}}
    var input=[Float](repeating:0,count:512),zero=input,re=input,im=input,result=[Float]();result.reserveCapacity(count*13)
    for f in 0..<count {
        for j in 0..<512 {let p=offset+f*160+j;let now=j<400 && p>=0 && p<pcm.count ? Double(pcm[p])*32768 : 0;let prior=p>0 && p-1<pcm.count ? Double(pcm[p-1])*32768 : 0;input[j]=j<400 ? Float(now-0.97*prior):0}
        vDSP_DFT_Execute(fft,input,zero,&re,&im)
        var power=[Double](repeating:0,count:257)
        for k in 0..<257 {let r=Double(re[k]),i=Double(im[k]);power[k]=(r*r+i*i)/512.0}
        let energy=max(Double.leastNonzeroMagnitude,power.reduce(0,+))
        var logMel=[Double](repeating:0,count:26)
        for m in 0..<26 {var sum=0.0;for k in 0..<257{sum += filters[m][k]*power[k]};logMel[m]=log(max(Double.ulpOfOne,sum))}
        for c in 0..<13 { var value=0.0;for m in 0..<26 {let angle = Double.pi * Double(c) * (Double(m)+0.5) / 26.0; value += logMel[m] * cos(angle)};value *= c==0 ? sqrt(1/26.0):sqrt(2/26.0);value *= 1+11*sin(Double.pi*Double(c)/22);result.append(Float(c==0 ? log(energy):value)) }
    };return result
}

func readAudio(_ asset: AVAsset, begin: Double, end: Double) async throws -> [Float] {
    let count=Int(ceil((end-begin)*16000))+400;var pcm=[Float](repeating:0,count:count)
    guard let track=try await asset.loadTracks(withMediaType:.audio).first else{return pcm}
    let reader=try AVAssetReader(asset:asset), output=AVAssetReaderTrackOutput(track:track,outputSettings:[AVFormatIDKey:kAudioFormatLinearPCM,AVSampleRateKey:16000,AVNumberOfChannelsKey:1,AVLinearPCMBitDepthKey:32,AVLinearPCMIsFloatKey:true,AVLinearPCMIsBigEndianKey:false,AVLinearPCMIsNonInterleaved:false]);output.alwaysCopiesSampleData=false
    reader.timeRange=CMTimeRange(start:CMTime(seconds:begin,preferredTimescale:48000),end:CMTime(seconds:end+0.025,preferredTimescale:48000));reader.add(output);guard reader.startReading() else{throw reader.error ?? SpeakerError("Cannot decode source audio.")}
    while let sample=output.copyNextSampleBuffer() {
        guard let data=CMSampleBufferGetDataBuffer(sample) else{continue};let length=CMBlockBufferGetDataLength(data);var bytes=[UInt8](repeating:0,count:length)
        guard CMBlockBufferCopyDataBytes(data,atOffset:0,dataLength:length,destination:&bytes)==kCMBlockBufferNoErr else{throw SpeakerError("Unreadable source audio.")}
        let at=Int(((CMSampleBufferGetPresentationTimeStamp(sample).seconds-begin)*16000).rounded())
        bytes.withUnsafeBytes{raw in let values=raw.bindMemory(to:Float.self);for j in 0..<values.count where at+j>=0 && at+j<pcm.count {pcm[at+j]=values[j].isFinite ? values[j]:0}}
    };guard reader.status == .completed else{throw reader.error ?? SpeakerError("Audio decoding stopped early.")};return pcm
}

final class SpeakerTrack {
    let id: Int
    let first: Int
    let boxes: [FaceBox]
    let cropBoxes: [FaceBox]
    var pixels: [UInt8]
    var scores: [Double?]
    init(id: Int, first: Int, boxes: [FaceBox], cropBoxes: [FaceBox]) {
        self.id=id; self.first=first; self.boxes=boxes; self.cropBoxes=cropBoxes
        pixels=[UInt8](repeating:110,count:boxes.count*112*112)
        scores=[Double?](repeating:nil,count:boxes.count)
    }
}

func median(_ values: [Double]) -> Double { let sorted=values.sorted(); return sorted[sorted.count/2] }

/// Interpolate brief gaps, then apply the upstream 13-frame median to crop centers
/// and size. Original detection boxes remain available for conservative framing.
func prepareTracks(_ frames: [FrameEvidence], width: Double, height: Double) -> [SpeakerTrack] {
    var observations=[Int:[(Int,FaceBox)]]()
    for (index,frame) in frames.enumerated() { for box in frame.boxes { observations[box.id,default:[]].append((index,box)) } }
    var tracks=[SpeakerTrack]()
    for id in observations.keys.sorted() {
        guard let points=observations[id],let first=points.first,let last=points.last else{continue}
        // Detection runs every five frames; extrapolate only its normal cadence,
        // never across a shot cut or an unbounded disappearance.
        var finish=min(frames.count-1,last.0+4)
        if last.0+1<=finish {for i in (last.0+1)...finish where frames[i].cut {finish=i-1;break}}
        guard finish>=first.0 else{continue}
        var boxes=[FaceBox]();var segment=0
        for frame in first.0...finish {
            while segment+1<points.count && points[segment+1].0<=frame {segment+=1}
            let a=points[segment];var b=a.1
            if segment+1<points.count {
                let next=points[segment+1],t=Double(frame-a.0)/Double(next.0-a.0)
                b.x += (next.1.x-b.x)*t;b.y += (next.1.y-b.y)*t
                b.w += (next.1.w-b.w)*t;b.h += (next.1.h-b.h)*t
                b.confidence=min(b.confidence,next.1.confidence)
            }
            boxes.append(b)
        }
        let centers=boxes.map{(($0.x+$0.w/2)*width,($0.y+$0.h/2)*height,max($0.w*width,$0.h*height)/2)}
        var crops=[FaceBox]()
        for i in boxes.indices {
            // Edge replication avoids the zero-padding shrink of scipy.medfilt.
            let neighbors=(-6...6).map{centers[min(centers.count-1,max(0,i+$0))]}
            let x=median(neighbors.map{$0.0}),y=median(neighbors.map{$0.1}),size=median(neighbors.map{$0.2})
            crops.append(FaceBox(id:id,x:(x-size)/width,y:(y-size)/height,w:2*size/width,h:2*size/height,confidence:boxes[i].confidence))
        }
        tracks.append(SpeakerTrack(id:id,first:first.0,boxes:boxes,cropBoxes:crops))
    }
    return tracks
}

/// Two decode passes retain metadata and compact face pixels, never full video
/// frames for a whole section. Memory remains bounded for two-hour source jobs.
func videoFrames(asset: AVAsset, track: AVAssetTrack, sourceStart: Double, start: Double, end: Double,
                 transform: CGAffineTransform, context: CIContext, parent: pid_t,
                 visit: (Int,Double,CGImage) throws -> Void) throws {
    let reader=try AVAssetReader(asset:asset)
    let output=AVAssetReaderTrackOutput(track:track,outputSettings:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA,kCVPixelBufferIOSurfacePropertiesKey as String:[:]])
    output.alwaysCopiesSampleData=false;reader.add(output)
    reader.timeRange=CMTimeRange(start:CMTime(seconds:sourceStart+start,preferredTimescale:60000),end:CMTime(seconds:sourceStart+end,preferredTimescale:60000))
    guard reader.startReading() else{throw reader.error ?? SpeakerError("Cannot decode source video.")}
    defer{reader.cancelReading()}
    var next=output.copyNextSampleBuffer(),previous:CMSampleBuffer?
    for index in 0..<Int(ceil((end-start)*25-1e-9)) {
        guard getppid()==parent else{throw SpeakerError("The analysis owner closed.")}
        let relative=start+Double(index)/25,target=sourceStart+relative
        while let sample=next,CMSampleBufferGetPresentationTimeStamp(sample).seconds<=target+0.000001 {previous=sample;next=output.copyNextSampleBuffer()}
        guard let sample=previous ?? next,let buffer=CMSampleBufferGetImageBuffer(sample) else{throw SpeakerError("Source video ended before the requested span.")}
        try autoreleasepool {
            var ci=CIImage(cvPixelBuffer:buffer,options:[.colorSpace:NSNull()]).transformed(by:transform)
            ci=ci.transformed(by:CGAffineTransform(translationX:-ci.extent.minX,y:-ci.extent.minY))
            let factor=min(1,960/max(ci.extent.width,ci.extent.height));ci=ci.transformed(by:CGAffineTransform(scaleX:factor,y:factor))
            guard let image=context.createCGImage(ci,from:ci.extent) else{throw SpeakerError("Could not read a source frame.")}
            try visit(index,relative,image)
        }
    }
    if reader.status == .failed {throw reader.error ?? SpeakerError("Source decoding failed.")}
}

@main struct SpeakerAnalysis {
    static func main() async {do{try await run()}catch{FileHandle.standardError.write(Data("Local speaker analysis failed: \(error)\n".utf8));exit(1)}}
    static func run() async throws {
        let args=CommandLine.arguments,parent=getppid()
        guard args.count==7,let start=Double(args[3]),let end=Double(args[4]),let origin=Double(args[5]),let interval=Double(args[6]),start>=0,end>start,end-start<=42,origin>=0,interval==0.5 else{throw SpeakerError("Expected source,model,start,end,source origin,and0.5s interval.")}
        let asset=AVURLAsset(url:URL(fileURLWithPath:args[1]))
        guard let track=try await asset.loadTracks(withMediaType:.video).first else{throw SpeakerError("No video track.")}
        let transform=try await track.load(.preferredTransform),natural=try await track.load(.naturalSize)
        let oriented=CGRect(origin:.zero,size:natural).applying(transform).standardized
        let segments=try await track.load(.segments),contentSegments=segments.filter{!$0.isEmpty}
        guard let contentStart=contentSegments.first?.timeMapping.target.start,segments.allSatisfy({!$0.isEmpty || CMTimeCompare($0.timeMapping.target.end,contentStart)<=0}) else{throw SpeakerError("Speaker analysis cannot safely align footage with internal video gaps.")}
        let probe=try AVAssetReader(asset:asset),probeOutput=AVAssetReaderTrackOutput(track:track,outputSettings:[kCVPixelBufferPixelFormatTypeKey as String:kCVPixelFormatType_32BGRA])
        probeOutput.alwaysCopiesSampleData=false;probe.add(probeOutput)
        guard probe.startReading() else{throw SpeakerError("Cannot verify the source video clock.")}
        var firstPTS=Double.nan
        while let first=probeOutput.copyNextSampleBuffer() {if CMTimeCompare(CMSampleBufferGetPresentationTimeStamp(first),contentStart)>=0,CMSampleBufferGetImageBuffer(first) != nil {firstPTS=CMSampleBufferGetPresentationTimeStamp(first).seconds;break}}
        probe.cancelReading()
        guard firstPTS.isFinite,abs(firstPTS-origin)<0.002 else{throw SpeakerError("The source video clock changed. Refresh the footage before speaker analysis.")}
        let duration=try await track.load(.timeRange).end.seconds-origin
        guard duration.isFinite,end<=duration+0.05,oriented.width>0,oriented.height>0 else{throw SpeakerError("The requested video clock or dimensions are invalid.")}
        let total=Int(ceil((end-start)/interval-1e-9)),count=Int(ceil((end-start)*25-1e-9))
        try emit(["type":"header","duration":duration,"sourceStart":origin,"width":Int(oriented.width.rounded()),"height":Int(oriented.height.rounded()),"total":total,"sampleInterval":interval])
        var lastProgress=0
        func progress(_ fraction:Double) throws {
            let completed=min(total-1,max(0,Int(Double(total)*fraction)))
            if completed>lastProgress {try emit(["type":"progress","completed":completed]);lastProgress=completed}
        }
        let imageTransform=CGAffineTransform(a:transform.a,b:-transform.b,c:-transform.c,d:transform.d,tx:0,ty:0)
        let context=CIContext(options:[.cacheIntermediates:false,.workingColorSpace:NSNull(),.outputColorSpace:NSNull()])
        var frames=[FrameEvidence](),recent=[Int:(Int,FaceBox)](),nextID=0,previousThumb:[UInt8]?,imageWidth=0.0,imageHeight=0.0
        try videoFrames(asset:asset,track:track,sourceStart:origin,start:start,end:end,transform:imageTransform,context:context,parent:parent) {index,time,image in
            imageWidth=Double(image.width);imageHeight=Double(image.height)
            let thumb=thumbnail(image),cut=isCut(previousThumb,thumb);previousThumb=thumb
            if cut {recent.removeAll(keepingCapacity:true)}
            var foundBoxes=[FaceBox]()
            if index%5==0 || cut {
                recent=recent.filter{index-$0.value.0<=10}
                let detection=VNDetectFaceRectanglesRequest();try VNImageRequestHandler(cgImage:image,orientation:.up,options:[:]).perform([detection])
                let found=(detection.results ?? []).filter{$0.confidence>=0.5 && min($0.boundingBox.width*imageWidth,$0.boundingBox.height*imageHeight)>=24}.sorted{$0.boundingBox.width*$0.boundingBox.height>$1.boundingBox.width*$1.boundingBox.height}.prefix(8)
                var unused=recent
                for observation in found {
                    let r=observation.boundingBox
                    var box=FaceBox(id:nextID,x:r.minX,y:1-r.maxY,w:r.width,h:r.height,confidence:Double(observation.confidence))
                    if let best=unused.max(by:{overlap($0.value.1,box)<overlap($1.value.1,box)}),overlap(best.value.1,box)>0.25 {box.id=best.key;unused.removeValue(forKey:best.key)}else{nextID+=1}
                    recent[box.id]=(index,box);foundBoxes.append(box)
                }
            }
            frames.append(FrameEvidence(time:time,cut:cut,boxes:foundBoxes));try progress(0.12*Double(index+1)/Double(count))
        }
        let tracks=prepareTracks(frames,width:imageWidth,height:imageHeight)
        var frameTracks=[[Int]](repeating:[],count:count)
        for (tid,t) in tracks.enumerated() {for i in t.boxes.indices {frameTracks[t.first+i].append(tid)}}
        try videoFrames(asset:asset,track:track,sourceStart:origin,start:start,end:end,transform:imageTransform,context:context,parent:parent) {index,_,image in
            for tid in frameTracks[index] {
                let t=tracks[tid],offset=index-t.first,crop=faceCrop(image,t.cropBoxes[offset])
                t.pixels.replaceSubrange((offset*12544)..<((offset+1)*12544),with:crop)
            }
            try progress(0.12+0.12*Double(index+1)/Double(count))
        }
        let pcm=try await readAudio(asset,begin:origin+start,end:origin+end)
        let features=try mfcc(pcm,offset:0,count:count*4)
        let config=MLModelConfiguration();config.computeUnits = .cpuAndGPU
        let modelURL=URL(fileURLWithPath:args[2]);var models=[Int:MLModel]()
        for seconds in 1...6 {
            let url=seconds==2 ? modelURL:modelURL.deletingLastPathComponent().appendingPathComponent("speaker-model-\(seconds)s.mlmodelc")
            models[seconds]=try MLModel(contentsOf:url,configuration:config)
        }
        let eligible=tracks.filter{$0.boxes.count>=25}
        for (trackNumber,t) in eligible.enumerated() {
            var combined=[Double](repeating:0,count:t.boxes.count),votes=[Int](repeating:0,count:t.boxes.count)
            for seconds in 1...6 {
                guard getppid()==parent else{throw SpeakerError("The analysis owner closed.")}
                let size=seconds*25
                guard t.boxes.count>=size else{continue}
                // Source-aligned windows plus real edge windows: no duplicated
                // face/next-shot audio padding. Six-second chunk context keeps
                // the retained interior independent of helper chunk boundaries.
                var starts=Set([0,t.boxes.count-size])
                let absoluteFirst=start+Double(t.first)/25
                let stride=Double(seconds)/2
                var anchor=ceil((absoluteFirst+1e-6)/stride)*stride
                while anchor+Double(seconds)<=absoluteFirst+Double(t.boxes.count)/25+1e-6 {
                    starts.insert(Int(((anchor-absoluteFirst)*25).rounded()));anchor+=stride
                }
                var sums=[Double](repeating:0,count:t.boxes.count),weights=[Double](repeating:0,count:t.boxes.count)
                for offset in starts.sorted() {
                    try autoreleasepool {
                        let audio=try MLMultiArray(shape:[1,NSNumber(value:size*4),13],dataType:.float32)
                        let video=try MLMultiArray(shape:[1,NSNumber(value:size),112,112],dataType:.float32)
                        let ap=audio.dataPointer.assumingMemoryBound(to:Float.self),vp=video.dataPointer.assumingMemoryBound(to:Float.self)
                        let featureStart=(t.first+offset)*4*13,pixelStart=offset*12544
                        for i in 0..<(size*4*13) {ap[i]=features[featureStart+i]}
                        for i in 0..<(size*12544) {vp[i]=Float(t.pixels[pixelStart+i])}
                        let provider=try MLDictionaryFeatureProvider(dictionary:["audio":audio,"video":video])
                        let output=try models[seconds]!.prediction(from:provider)
                        guard let logits=output.featureValue(for:"logits")?.multiArrayValue,logits.count==size*2 else{throw SpeakerError("The active-speaker model returned unexpected output.")}
                        for i in 0..<size {
                            let weight=max(0.01,1-abs((Double(i)+0.5)/Double(size)*2-1))
                            sums[offset+i]+=logits[i*2+1].doubleValue*weight;weights[offset+i]+=weight
                        }
                    }
                }
                for i in sums.indices where weights[i]>0 {combined[i]+=sums[i]/weights[i];votes[i]+=1}
                try progress(0.24+0.70*(Double(trackNumber)+Double(seconds)/6)/Double(max(1,eligible.count)))
            }
            for i in combined.indices where votes[i]>0 {t.scores[i]=combined[i]/Double(votes[i])}
            // Free each compact pixel track after inference, before the next one.
            t.pixels.removeAll(keepingCapacity:false)
        }
        var emitted=0,pendingCut=false
        for (index,frame) in frames.enumerated() {
            pendingCut = pendingCut || frame.cut
            // A trim may end between the last25fps frame and the final half-second
            // sample. Use that last preceding frame instead of losing the slot.
            guard frame.time+0.000001>=start+Double(emitted)*interval || (index==frames.count-1 && emitted<total) else{continue}
            let a0=max(0,Int(((frame.time-start)*16000).rounded())),a1=min(pcm.count,a0+8000)
            let rms=a1>a0 ? sqrt(pcm[a0..<a1].reduce(0.0){$0+Double($1)*Double($1)}/Double(a1-a0)):0
            let faces=frameTracks[index].prefix(8).compactMap{tid -> [String:Any]? in
                let t=tracks[tid],local=index-t.first
                guard let box=displayBox(t.boxes[local]) else{return nil}
                let neighborhood=(max(0,local-2)...min(t.scores.count-1,local+2)).compactMap{t.scores[$0]}
                let score:Double?=neighborhood.isEmpty ? nil:neighborhood.reduce(0,+)/Double(neighborhood.count)
                return ["trackId":String(t.id),"x":box.x,"y":box.y,"width":box.w,"height":box.h,"confidence":box.confidence,"speakingScore":score as Any? ?? NSNull()]
            }
            let ranked=faces.compactMap{face -> (String,Double)? in guard let score=face["speakingScore"] as? Double else{return nil};return(face["trackId"] as! String,score)}.sorted{$0.1>$1.1}
            var active:String?,reason="uncertain"
            if rms<0.003 {reason="silence"}
            else if faces.isEmpty {reason="no-visible-speaker"}
            else if let first=ranked.first,first.1>0.5 {
                if ranked.count>1 && ranked[1].1>0.5 && first.1-ranked[1].1<1.0 {reason="overlap"}
                else if ranked.count==1 || first.1-ranked[1].1>=0.75 {active=first.0;reason="speaker"}
            }
            try emit(["type":"sample","time":start+Double(emitted)*interval,"cut":pendingCut,"faces":faces,"activeTrackId":active as Any? ?? NSNull(),"reason":reason,"audioRms":rms]);emitted+=1;pendingCut=false
        }
        guard emitted==total else{throw SpeakerError("Incomplete speaker sample timeline (\(emitted)/\(total)).")}
        try emit(["type":"done","completed":emitted])
    }
}
