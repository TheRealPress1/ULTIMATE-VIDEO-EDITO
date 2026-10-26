#!/usr/bin/env python3
"""Build-only conversion; the installed app runs CoreML, never Python.
Python3.11: pip install torch==2.7.1 coremltools==9.0 numpy==1.26.4
Usage: python scripts/convert-speaker-model.py
"""
import hashlib, json, pathlib, shutil, sys, tempfile, urllib.request
import numpy as np
import torch
import coremltools as ct
ROOT = pathlib.Path(__file__).resolve().parents[1]
COMMIT = 'ed38c232de5efe0261dbd68627c0ade7cdfe14eb'
MODEL_SHA = 'd44bc3ea7baa8e0946fa3921311714a630ed8b90a1928fab0dbe30d918909317'
SOURCE = f'https://raw.githubusercontent.com/Junhua-Liao/Light-ASD/{COMMIT}/weight/pretrain_AVA_CVPR.model'
sys.path.insert(0, str(ROOT/'src/native/vendor/light-asd'))
from model.Model import ASD_Model
class Inference(torch.nn.Module):
    def __init__(self, state):
        super().__init__()
        self.model = ASD_Model()
        self.fc = torch.nn.Linear(128, 2)
        self.model.load_state_dict({k[6:]:v for k,v in state.items() if k.startswith('model.')})
        self.fc.load_state_dict({k[len('lossAV.FC.'):]:v for k,v in state.items() if k.startswith('lossAV.FC.')})
        # The upstream4D tensor's MaxPool3d treats batch as its channel axis.
        # Its depth/height kernels are1, so2D pooling is exactly equivalent.
        self.model.audioEncoder.pool1 = torch.nn.MaxPool2d((1,3),(1,2),(0,1))
        self.model.audioEncoder.pool2 = torch.nn.MaxPool2d((1,3),(1,2),(0,1))
    def forward(self, audio, video):
        a = self.model.forward_audio_frontend(audio)
        v = self.model.forward_visual_frontend(video)
        return self.fc(self.model.forward_audio_visual_backend(a,v))
def main():
    torch.set_num_threads(4); torch.manual_seed(2026)
    with tempfile.TemporaryDirectory(prefix='uve-asd-conversion-') as temporary:
        source = pathlib.Path(temporary)/'weights.model'
        urllib.request.urlretrieve(SOURCE,source)
        if hashlib.sha256(source.read_bytes()).hexdigest() != MODEL_SHA: raise ValueError('Upstream model fingerprint mismatch')
        state = torch.load(source,map_location='cpu',weights_only=True)
        network = Inference(state).eval()
        # Assert pooling rewrite before export.
        original = ASD_Model().eval(); original.load_state_dict(network.model.state_dict())
        variants={}
        for seconds in range(1,7):
            frames=seconds*25
            a=torch.randn(1,frames*4,13);v=torch.rand(1,frames,112,112)*255
            with torch.no_grad():
                assert torch.equal(original.forward_audio_frontend(a),network.model.forward_audio_frontend(a))
                traced=torch.jit.trace(network,(a,v));expected=network(a,v).numpy()
            converted=ct.convert(traced,inputs=[ct.TensorType(name='audio',shape=a.shape),ct.TensorType(name='video',shape=v.shape)],outputs=[ct.TensorType(name='logits')],convert_to='mlprogram',minimum_deployment_target=ct.target.macOS13,compute_precision=ct.precision.FLOAT32)
            converted.author='Junhua Liao et al.; CoreML conversion by UVE'
            converted.license='MIT; see src/native/vendor/light-asd/LICENSE'
            converted.short_description=f'Light-ASD {seconds}s audio-visual speaker evidence; uncalibrated raw logits.'
            # Fixed shapes avoid GPU compiler failures seen with dynamic GRU inputs.
            actual=converted.predict({'audio':a.numpy(),'video':v.numpy()})['logits']
            error=float(np.max(np.abs(actual-expected)))
            if error>0.0001: raise ValueError(f'Conversion parity failed for {seconds}s: {error}')
            name='LightASD.mlpackage' if seconds==2 else f'LightASD-{seconds}s.mlpackage'
            staging=pathlib.Path(temporary)/name;converted.save(str(staging))
            destination=ROOT/'models'/name
            if destination.exists(): shutil.rmtree(destination)
            shutil.move(staging,destination)
            variants[str(seconds)]={'package':name,'input':{'audio':[1,frames*4,13],'video':[1,frames,112,112]},'parityMaxError':error,'files':{str(p.relative_to(destination)):hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(destination.rglob('*')) if p.is_file()}}
            print(json.dumps({'package':str(destination),'parityMaxError':error}),flush=True)
        manifest={'engine':'light-asd-coreml-ava-v2','upstream':f'https://github.com/Junhua-Liao/Light-ASD/tree/{COMMIT}','checkpoint':SOURCE,'checkpointSHA256':MODEL_SHA,'license':'MIT','input':variants['2']['input'],'fps':25,'audioRate':16000,'parityMaxError':max(v['parityMaxError'] for v in variants.values()),'files':variants['2']['files'],'variants':variants,'inference':{'durations':[1,2,3,4,5,6],'cropMedianFrames':13,'maxDetectionGapFrames':10,'chunkContextSeconds':6,'speakingLogitThreshold':0.5,'winnerMargin':0.75,'windowStrideRatio':0.5,'windowWeighting':'triangular-center'}}
        (ROOT/'models/speaker-model.json').write_text(json.dumps(manifest,indent=2)+'\n')
if __name__=='__main__':main()
