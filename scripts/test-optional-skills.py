#!/usr/bin/env python3
"""Offline checks for the optional skill launcher; never contacts a provider."""

import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch
import wave

ROOT = Path(__file__).resolve().parents[1]
LAUNCHER = ROOT / "docs/skills/imports/run.py"
spec = importlib.util.spec_from_file_location("uve_optional_skills", LAUNCHER)
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class OptionalSkillsTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.project = Path(self.temp.name)
        with wave.open(str(self.project / "source.wav"), "wb") as audio:
            audio.setnchannels(1)
            audio.setsampwidth(2)
            audio.setframerate(16000)
            audio.writeframes(b"\0\0" * 160)

    def call(self, *args, execute=False):
        command = [str(LAUNCHER), "speech", "--project", str(self.project), "--output", "assets/voice.mp3", "--text", "Offline test."]
        if execute:
            command += ["--execute"]
        command += list(args)
        with patch.object(sys, "argv", command), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return launcher.main()

    def test_dry_runs_need_no_sdk_or_key_and_write_nothing(self):
        env = os.environ.copy()
        env.pop("OPENAI_API_KEY", None)
        commands = [
            ["speech", "--text", "Offline narration.", "--output", "assets/voice.mp3"],
            ["transcribe", "--input", "source.wav", "--output", "transcripts/speakers.json", "--format", "diarized_json"],
        ]
        for command in commands:
            result = subprocess.run([sys.executable, "-B", str(LAUNCHER), *command, "--project", str(self.project)], env=env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(p.name for p in self.project.iterdir()), ["source.wav"])

    def test_status_never_exposes_credential(self):
        with patch.dict(os.environ, {"OPENAI_API_KEY": "test-value-must-not-appear"}):
            status = launcher.availability()
        self.assertTrue(status["apiKeyConfigured"])
        self.assertNotIn("test-value-must-not-appear", json.dumps(status))
        self.assertFalse(status["liveServiceVerified"])

    def test_existing_output_and_paths_outside_project_are_rejected(self):
        (self.project / "assets").mkdir()
        original = self.project / "assets/voice.mp3"
        original.write_bytes(b"keep")
        self.assertEqual(self.call(), 1)
        self.assertEqual(original.read_bytes(), b"keep")
        with self.assertRaises(ValueError):
            launcher.output_path(self.project, "../outside.mp3", "mp3")
        (self.project / "escape").symlink_to(self.project.parent, target_is_directory=True)
        with self.assertRaises(ValueError):
            launcher.output_path(self.project, "escape/outside.mp3", "mp3")

    def test_live_requires_prerequisites_before_launch(self):
        with patch.object(launcher, "availability", return_value={"openaiSdkAvailable": False, "apiKeyConfigured": False}), patch.object(launcher.subprocess, "run") as run:
            self.assertEqual(self.call(execute=True), 1)
            run.assert_not_called()

    def live_with_fake(self, handler):
        with patch.object(launcher, "availability", return_value={"openaiSdkAvailable": True, "apiKeyConfigured": True}), patch.object(launcher.subprocess, "run", side_effect=handler):
            return self.call(execute=True)

    def test_success_publishes_new_file_and_cleans_temporary_directory(self):
        def fake(command, **kwargs):
            Path(command[command.index("--out") + 1]).write_bytes(b"generated")
            return subprocess.CompletedProcess(command, 0)
        self.assertEqual(self.live_with_fake(fake), 0)
        self.assertEqual((self.project / "assets/voice.mp3").read_bytes(), b"generated")
        self.assertFalse(list(self.project.glob(".uve-cloud-*")))

    def test_failed_provider_does_not_publish_partial_output(self):
        def fake(command, **kwargs):
            Path(command[command.index("--out") + 1]).write_bytes(b"partial")
            return subprocess.CompletedProcess(command, 1)
        self.assertEqual(self.live_with_fake(fake), 1)
        self.assertFalse((self.project / "assets/voice.mp3").exists())
        self.assertFalse(list(self.project.glob(".uve-cloud-*")))

    def test_concurrent_output_is_preserved(self):
        def fake(command, **kwargs):
            Path(command[command.index("--out") + 1]).write_bytes(b"generated")
            (self.project / "assets").mkdir()
            (self.project / "assets/voice.mp3").write_bytes(b"user-file")
            return subprocess.CompletedProcess(command, 0)
        self.assertEqual(self.live_with_fake(fake), 1)
        self.assertEqual((self.project / "assets/voice.mp3").read_bytes(), b"user-file")


if __name__ == "__main__":
    unittest.main()
