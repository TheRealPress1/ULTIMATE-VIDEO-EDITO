#!/usr/bin/env python3
"""Run the bundled optional OpenAI skills; dry-run unless --execute is supplied."""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

BASE = Path(__file__).resolve().parent
SCRIPTS = {
    "transcribe": BASE / "openai/transcribe/scripts/transcribe_diarize.py",
    "speech": BASE / "openai/speech/scripts/text_to_speech.py",
}


def availability() -> dict:
    return {
        "python": sys.version.split()[0],
        "openaiSdkAvailable": importlib.util.find_spec("openai") is not None,
        "apiKeyConfigured": bool(os.environ.get("OPENAI_API_KEY")),
        "liveServiceVerified": False,
        "defaultMode": "dry-run",
        "service": "OpenAI API (separate from the connected editing-agent subscription)",
    }


def output_path(project: Path, value: str, extension: str) -> Path:
    output = Path(value)
    if not output.is_absolute():
        output = project / output
    resolved = output.resolve()
    if not resolved.is_relative_to(project):
        raise ValueError("Output must stay inside the project folder.")
    if resolved.suffix.lower() != "." + extension:
        raise ValueError("Output extension must be ." + extension + ".")
    if output.exists() or output.is_symlink():
        raise ValueError("Output already exists; choose a new filename.")
    return resolved


def source_path(project: Path, value: str) -> Path:
    path = Path(value)
    path = (path if path.is_absolute() else project / path).resolve()
    if not path.is_file():
        raise ValueError("Input file does not exist: " + str(path))
    return path


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest="mode", required=True)
    modes.add_parser("status", help="Show local prerequisites without contacting a service")
    for mode in ("transcribe", "speech"):
        p = modes.add_parser(mode)
        p.add_argument("--project", required=True, help="Absolute project folder")
        p.add_argument("--output", required=True, help="New output path inside the project")
        p.add_argument("--execute", action="store_true", help="Make a paid API request; default is dry-run")
        p.add_argument("--model")
        if mode == "transcribe":
            p.add_argument("--input", required=True, help="Audio file")
            p.add_argument("--format", choices=("text", "json", "diarized_json"), default="text")
            p.add_argument("--language")
            p.add_argument("--prompt")
        else:
            text = p.add_mutually_exclusive_group(required=True)
            text.add_argument("--text")
            text.add_argument("--text-file")
            p.add_argument("--voice", default="cedar")
            p.add_argument("--format", choices=("mp3", "opus", "aac", "flac", "wav", "pcm"), default="mp3")
            p.add_argument("--instructions")
            p.add_argument("--speed", type=float, default=1.0)
    args = parser.parse_args()
    if args.mode == "status":
        print(json.dumps(availability(), indent=2))
        return 0
    project = Path(args.project).resolve()
    if not project.is_dir():
        parser.error("Project folder does not exist.")
    try:
        extension = ("txt" if args.format == "text" else "json") if args.mode == "transcribe" else args.format
        output = output_path(project, args.output, extension)
        command = [sys.executable, "-B", str(SCRIPTS[args.mode])]
        if args.mode == "transcribe":
            source = source_path(project, args.input)
            if source.stat().st_size > 25 * 1024 * 1024:
                raise ValueError("Audio exceeds 25 MB. Prepare a smaller derivative or split it first.")
            command += [str(source), "--response-format", args.format, "--chunking-strategy", "auto"]
            model = args.model or ("gpt-4o-transcribe-diarize" if args.format == "diarized_json" else "gpt-4o-mini-transcribe")
            command += ["--model", model]
            if args.language:
                command += ["--language", args.language]
            if args.prompt:
                command += ["--prompt", args.prompt]
        else:
            command += ["speak", "--voice", args.voice, "--response-format", args.format, "--speed", str(args.speed), "--attempts", "1"]
            if args.text is not None:
                command += ["--input", args.text]
            else:
                command += ["--input-file", str(source_path(project, args.text_file))]
            if args.model:
                command += ["--model", args.model]
            if args.instructions:
                command += ["--instructions", args.instructions]
        if not args.execute:
            return subprocess.run(command + ["--out", str(output), "--dry-run"], cwd=project).returncode
        ready = availability()
        if not ready["openaiSdkAvailable"] or not ready["apiKeyConfigured"]:
            raise ValueError("Live calls require the OpenAI Python SDK and OPENAI_API_KEY. Run status for availability.")
        # Upstream writers are unchanged. Write in an isolated directory, then
        # publish exclusively so an error or existing asset cannot be overwritten.
        with tempfile.TemporaryDirectory(prefix=".uve-cloud-", dir=project) as temp:
            staged = Path(temp) / ("result." + extension)
            result = subprocess.run(command + ["--out", str(staged)], cwd=project)
            if result.returncode:
                return result.returncode
            if not staged.is_file() or staged.stat().st_size == 0:
                raise ValueError("Provider returned no output file.")
            output = output_path(project, args.output, extension)
            output.parent.mkdir(parents=True, exist_ok=True)
            output = output_path(project, args.output, extension)
            os.link(staged, output)
        print(json.dumps({"output": str(output), "service": "OpenAI", "mode": args.mode}))
        return 0
    except (ValueError, OSError) as error:
        print("Error: " + str(error), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
