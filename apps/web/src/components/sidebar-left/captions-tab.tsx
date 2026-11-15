/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// The Captions tab: transcribe a scene on this Mac, fix the words, and make
// or update its caption layer. The logic is in captions-tab-data.ts; the
// transcription and the caption layer are the engine's (generate/captions).

import { batch, createEffect, createMemo, createSignal, For, Index, Match, on, onCleanup, Show, Switch, type JSX } from "solid-js";
import { useQuery, useWorld } from "@diffusionstudio/koota-solid";
import { authoredElement } from "@diffusionstudio/reconciler";
import { Caption, Computed, FrameRate, Name, Scene, setPlayhead, stopPlayback } from "@diffusionstudio/runtime";
import { toast } from "somoto";

import { SidebarTabs } from "@/agent-chat";
import { useProject } from "@/context/project";
import { mountSceneCaptions, sceneCaption, sceneTranscriptionProblem, transcribeScene } from "@/engine/generate/captions";
import { useActiveScene, useSelection } from "@/engine/hooks";
import { useLibrary } from "@/engine/library";
import { isTranscriptionCanceled } from "@/lib/local-transcription";
import { isDesktop } from "@/projects/host";
import { Button } from "../ui/button";
import { CAPTION_PRESET_OPTIONS, captionPresetOption } from "../sidebar-right/inspector/caption-types";
import {
  CAPTION_LANGUAGES,
  captionTranscript,
  clock,
  DEFAULT_CAPTION_STYLE,
  findWord,
  fixWord,
  latestTranscript,
  parseTranscript,
  replaceWord,
  textCaseProp,
  TRANSCRIPTS_FOLDER,
  transcriptFileName,
  wordAt,
  wordCount,
  type CaptionCase,
  type CaptionStyle,
  type CaptionWords,
  type WordAt,
} from "./captions-tab-data";

import type { Transcript } from "@diffusionstudio/assets";
import type { SpeechQuality } from "@desktop/speech-types";
import type { Entity } from "koota";

/** One scene's transcript as the tab holds it. */
type Draft = {
  transcript: Transcript;
  /** Words fixed since the transcript was last saved, by "segment:word". */
  fixed: ReadonlySet<string>;
  /** Unsaved fixes: saving writes a new transcript file. */
  dirty: boolean;
};

type Progress = { message: string; fraction: number | null };

const key = (at: WordAt) => `${at.segment}:${at.word}`;

/** The Captions tab, beside Project, Media and Footage. */
export function CaptionsTab() {
  return (
    <div class="flex flex-1 min-h-0 flex-col">
      <div class="h-9 shrink-0 flex items-center px-4 border-y border-border [[data-platform=win32]_&]:border-t-0"><SidebarTabs group="project" /></div>
      <Show when={isDesktop()} fallback={<p class="p-4 text-xs text-muted-foreground">Captions are made on this Mac, in the desktop app.</p>}>
        <Captions />
      </Show>
    </div>
  );
}

function Captions() {
  const world = useWorld();
  const project = useProject();
  const library = useLibrary();
  const active = useActiveScene();
  const { nodes } = useSelection();
  // Caption layers coming and going, so "Make" turns into "Update" and back.
  const captionLayers = useQuery(Caption);

  // The selected scene, or the active one: the same scene Generate captions uses.
  const scene = createMemo<Entity | null>(() => nodes().find((node) => node.has(Scene)) ?? active());
  const sceneLabel = () => scene()?.get(Name)?.value || "Scene";
  const sceneKey = () => {
    const target = scene();
    const id = target ? authoredElement(target)?.props.id : undefined;
    return typeof id === "string" && id ? id : sceneLabel();
  };

  const [drafts, setDrafts] = createSignal<ReadonlyMap<Entity, Draft>>(new Map());
  const draft = () => {
    const target = scene();
    return target ? drafts().get(target) : undefined;
  };
  const setDraft = (target: Entity, next: Draft | undefined) => setDrafts((map) => {
    const copy = new Map(map);
    if (next) copy.set(target, next);
    else copy.delete(target);
    return copy;
  });

  const [quality, setQuality] = createSignal<SpeechQuality>("accurate");
  const [language, setLanguage] = createSignal("");
  const [style, setStyle] = createSignal<CaptionStyle>(DEFAULT_CAPTION_STYLE);
  const [progress, setProgress] = createSignal<Progress>();
  const [loading, setLoading] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [problem, setProblem] = createSignal<string>();
  let controller: AbortController | undefined;
  onCleanup(() => controller?.abort());

  // A caption layer the scene already has sets the style's preset and case.
  createEffect(on(scene, (target) => {
    const layer = target ? sceneCaption(world, target) : undefined;
    if (!layer) return;
    const preset = captionPresetOption(layer.get(Caption)?.type).name;
    const authored = authoredElement(layer)?.props.textCase;
    const textCase: CaptionCase = authored === "original" || authored === "lower" || authored === "upper" ? authored : "preset";
    setStyle((current) => ({ ...current, preset, textCase }));
  }));

  /** The scene's saved transcript, read into the tab the first time the scene is shown. */
  createEffect(on([scene, library], async ([target, lib]) => {
    if (!target || !lib || drafts().has(target)) return;
    const saved = latestTranscript(lib.list(), sceneKey());
    if (!saved) return;
    setLoading(true);
    try {
      const transcript = parseTranscript(JSON.parse(await (await lib.file(saved)).text()));
      if (!drafts().has(target)) setDraft(target, { transcript, fixed: new Set(), dirty: false });
    } catch (error) {
      toast.error(`Could not read ${saved.path}`, { description: (error as Error).message });
    } finally {
      setLoading(false);
    }
  }));

  // The scene's existing captions, made before this tab, as a starting transcript.
  const captionSource = createMemo(() => {
    captionLayers();
    const target = scene();
    const lib = library();
    const layer = target ? sceneCaption(world, target) : undefined;
    const src = layer ? authoredElement(layer)?.props.src : undefined;
    const asset = typeof src === "string" && lib ? lib.get(src) : undefined;
    return asset && asset.path.toLowerCase().endsWith(".json") ? asset : undefined;
  });
  const useCaptionWords = async () => {
    const target = scene();
    const lib = library();
    const asset = captionSource();
    if (!target || !lib || !asset) return;
    try {
      const transcript = parseTranscript(JSON.parse(await (await lib.file(asset)).text()));
      setDraft(target, { transcript, fixed: new Set(), dirty: true });
    } catch (error) {
      toast.error("Could not read the scene's captions", { description: (error as Error).message });
    }
  };

  const saveTranscript = async (transcript: Transcript) => {
    const lib = library();
    if (!lib) throw new Error("Open the project first.");
    const asset = await lib.store(new Blob([JSON.stringify(transcript)], { type: "application/json" }), {
      folder: TRANSCRIPTS_FOLDER,
      name: transcriptFileName(sceneKey()),
    });
    await lib.flush();
    return asset;
  };

  const transcribe = async () => {
    const target = scene();
    if (!target || progress()) return;
    const reason = sceneTranscriptionProblem(world, target);
    if (reason) {
      setProblem(reason.message);
      return;
    }
    setProblem(undefined);
    controller = new AbortController();
    setProgress({ message: "Starting", fraction: null });
    try {
      const transcript = await transcribeScene(world, target, project.dir(), {
        signal: controller.signal,
        quality: quality(),
        language: language() || undefined,
        onProgress: (message, fraction) => setProgress({ message, fraction }),
      }, async (result, checkCurrent) => {
        await saveTranscript(result);
        checkCurrent();
        return result;
      });
      setDraft(target, { transcript, fixed: new Set(), dirty: false });
      toast.success("Transcript ready", { description: `${wordCount(transcript)} words. Fix any that are wrong, then make captions.` });
    } catch (error) {
      if (controller.signal.aborted || isTranscriptionCanceled(error)) toast("Transcription canceled");
      else setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      controller = undefined;
      setProgress(undefined);
    }
  };

  const saveFixes = async () => {
    const target = scene();
    const current = draft();
    if (!target || !current || saving()) return;
    setSaving(true);
    try {
      await saveTranscript(current.transcript);
      setDraft(target, { ...current, dirty: false });
      toast.success("Fixes saved");
    } catch (error) {
      toast.error("Could not save the fixes", { description: (error as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const hasLayer = createMemo(() => {
    captionLayers();
    const target = scene();
    return !!target && !!sceneCaption(world, target);
  });

  const makeCaptions = async () => {
    const target = scene();
    const current = draft();
    if (!target || !current || saving()) return;
    setSaving(true);
    try {
      if (current.dirty) {
        await saveTranscript(current.transcript);
        setDraft(target, { ...current, dirty: false });
      }
      const chosen = style();
      const captions = captionTranscript(current.transcript, chosen);
      const result = await mountSceneCaptions(world, target, captions, { preset: chosen.preset, textCase: textCaseProp(chosen.textCase) }, `Captions ${transcriptFileName(sceneKey())}`);
      toast.success(result.added ? "Captions added" : "Captions updated", { description: `${captions.length} captions on ${sceneLabel()}.` });
    } catch (error) {
      toast.error("Could not make the captions", { description: (error as Error).message });
    } finally {
      setSaving(false);
    }
  };

  const fix = (at: WordAt, text: string) => {
    const target = scene();
    const current = draft();
    if (!target || !current) return;
    const before = current.transcript[at.segment]?.words[at.word]?.text;
    if (before === undefined || before === text.trim()) return;
    const transcript = fixWord(current.transcript, at, text);
    // Removing a word renumbers the ones after it, so only a retyped word keeps its mark.
    const removed = transcript.length !== current.transcript.length || transcript[at.segment]?.words.length !== current.transcript[at.segment]?.words.length;
    const fixed = removed ? new Set<string>() : new Set(current.fixed).add(key(at));
    setDraft(target, { transcript, fixed, dirty: true });
  };

  const replaceAll = (query: string, replacement: string) => {
    const target = scene();
    const current = draft();
    if (!target || !current) return 0;
    const places = findWord(current.transcript, query);
    const { transcript, count } = replaceWord(current.transcript, query, replacement);
    if (!count) return 0;
    const fixed = new Set(current.fixed);
    for (const place of places) fixed.add(key(place));
    setDraft(target, { transcript, fixed, dirty: true });
    return count;
  };

  const seek = (seconds: number) => {
    const target = scene();
    if (!target) return;
    const fps = world.get(FrameRate)?.value ?? 30;
    stopPlayback(world, target);
    setPlayhead(world, target, Math.round(seconds * fps));
  };

  // The playhead, read a few times a second, marks the word being said.
  const [now, setNow] = createSignal(0);
  const timer = setInterval(() => {
    const target = scene();
    if (target?.isAlive()) setNow(target.get(Computed)?.localTimeInSeconds ?? 0);
  }, 120);
  onCleanup(() => clearInterval(timer));

  return (
    <div class="flex flex-1 min-h-0 flex-col text-xs">
      <Show when={scene()} fallback={<p class="p-4 text-muted-foreground">Open or select a scene to caption it.</p>}>
        <Switch>
          <Match when={progress()}>
            {(current) => (
              <>
                <Source label={sceneLabel()} quality={quality()} language={language()} disabled onQuality={setQuality} onLanguage={setLanguage} />
                <section class="flex flex-col gap-2 border-b border-border px-3 py-3" aria-label="Transcribing">
                  <SectionTitle>Transcribing</SectionTitle>
                  <div class="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={current().fraction === null ? undefined : Math.round(current().fraction! * 100)}>
                    <div class="h-full rounded-full bg-primary transition-[width]" classList={{ "animate-pulse w-1/3": current().fraction === null }} style={current().fraction === null ? undefined : { width: `${Math.round(current().fraction! * 100)}%` }} />
                  </div>
                  <div class="flex justify-between gap-2 text-xxs text-muted-foreground">
                    <span class="min-w-0 truncate">{current().message}</span>
                    <Show when={current().fraction !== null}><span class="tabular-nums">{Math.round(current().fraction! * 100)}%</span></Show>
                  </div>
                  <Button variant="secondary" onClick={() => controller?.abort()}>Cancel</Button>
                  <p class="text-xxs text-muted-foreground/80">Nothing leaves this Mac. Long scenes go in sections, so a canceled run resumes where it stopped.</p>
                </section>
              </>
            )}
          </Match>
          <Match when={draft()}>
            {(current) => (
              <>
                <StylePanel
                  style={style()}
                  onStyle={setStyle}
                  hasLayer={hasLayer()}
                  busy={saving()}
                  dirty={current().dirty}
                  fixes={current().fixed.size}
                  onMake={makeCaptions}
                  onSave={saveFixes}
                  onTranscribeAgain={() => setDraft(scene()!, undefined)}
                />
                <TranscriptView transcript={current().transcript} fixed={current().fixed} now={now()} onSeek={seek} onFix={fix} onReplace={replaceAll} />
              </>
            )}
          </Match>
          <Match when={loading()}>
            <p class="p-4 text-muted-foreground">Reading the saved transcript…</p>
          </Match>
          <Match when={true}>
            <Source label={sceneLabel()} quality={quality()} language={language()} onQuality={setQuality} onLanguage={setLanguage} />
            <section class="flex flex-col gap-2 border-b border-border px-3 py-3">
              <Button onClick={transcribe}>Transcribe {sceneLabel()}</Button>
              <Show when={problem()}><p class="text-destructive" role="alert">{problem()}</p></Show>
              <p class="text-xxs text-muted-foreground/80">
                {quality() === "accurate" ? "Accurate uses the large Whisper model. The first run downloads it once; it stays on this Mac." : "Fast uses the small Whisper model: quicker, with more words to fix."}
              </p>
              <Show when={captionSource()}>
                <Button variant="ghost" onClick={useCaptionWords}>Use the words from this scene's captions</Button>
              </Show>
            </section>
            <div class="flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-muted-foreground">
              <span class="text-foreground">No transcript yet</span>
              <span>Transcribe the scene, then fix any words before making captions.</span>
            </div>
          </Match>
        </Switch>
      </Show>
    </div>
  );
}

function SectionTitle(props: { children: string }) {
  return <h3 class="text-xxs font-semibold uppercase tracking-wider text-muted-foreground">{props.children}</h3>;
}

function Row(props: { label: string; for?: string; children: JSX.Element }) {
  return (
    <div class="grid grid-cols-[96px_1fr] items-center gap-2">
      <label class="text-muted-foreground" for={props.for}>{props.label}</label>
      {props.children}
    </div>
  );
}

/** Buttons for one choice, the chosen one pressed. */
function Choice<T extends string | number>(props: { label: string; value: T; options: ReadonlyArray<[T, string]>; onChange: (value: T) => void; disabled?: boolean }) {
  return (
    <div class="flex gap-0.5 rounded-md bg-muted p-0.5" role="group" aria-label={props.label}>
      <For each={props.options}>
        {([value, label]) => (
          <button
            type="button"
            disabled={props.disabled}
            aria-pressed={props.value === value}
            class="h-5 flex-1 rounded text-xxs font-medium focus-ring disabled:opacity-50"
            classList={{ "bg-secondary text-foreground": props.value === value, "text-muted-foreground hover:text-foreground": props.value !== value }}
            onClick={() => props.onChange(value)}
          >
            {label}
          </button>
        )}
      </For>
    </div>
  );
}

function Source(props: { label: string; quality: SpeechQuality; language: string; disabled?: boolean; onQuality: (value: SpeechQuality) => void; onLanguage: (value: string) => void }) {
  return (
    <section class="flex flex-col gap-2 border-b border-border px-3 py-3" aria-label="Transcribe">
      <SectionTitle>Transcribe</SectionTitle>
      <div class="truncate rounded-md bg-muted px-2 py-1.5 text-foreground">{props.label}</div>
      <Row label="Quality">
        <Choice label="Quality" value={props.quality} options={[["fast", "Fast"], ["accurate", "Accurate"]]} onChange={props.onQuality} disabled={props.disabled} />
      </Row>
      <Row label="Language" for="captions-language">
        <select
          id="captions-language"
          class="h-6 rounded-md bg-muted px-2 text-foreground outline-none focus-ring disabled:opacity-50"
          value={props.language}
          disabled={props.disabled}
          onChange={(event) => props.onLanguage(event.currentTarget.value)}
        >
          <For each={CAPTION_LANGUAGES}>{(option) => <option value={option.code}>{option.label}</option>}</For>
        </select>
      </Row>
    </section>
  );
}

function StylePanel(props: {
  style: CaptionStyle;
  onStyle: (style: CaptionStyle) => void;
  hasLayer: boolean;
  busy: boolean;
  dirty: boolean;
  fixes: number;
  onMake: () => void;
  onSave: () => void;
  onTranscribeAgain: () => void;
}) {
  const set = (patch: Partial<CaptionStyle>) => props.onStyle({ ...props.style, ...patch });
  const [confirmAgain, setConfirmAgain] = createSignal(false);
  return (
    <section class="flex flex-col gap-2 border-b border-border px-3 py-3" aria-label="Style">
      <SectionTitle>Style</SectionTitle>
      <Row label="Preset" for="captions-preset">
        <select
          id="captions-preset"
          class="h-6 rounded-md bg-muted px-2 text-foreground outline-none focus-ring"
          value={props.style.preset}
          onChange={(event) => set({ preset: event.currentTarget.value as CaptionStyle["preset"] })}
        >
          <For each={CAPTION_PRESET_OPTIONS}>{(option) => <option value={option.name}>{option.label}</option>}</For>
        </select>
      </Row>
      <Row label="Words at once">
        <Choice<CaptionWords> label="Words at once" value={props.style.words} options={[[1, "1"], [2, "2"], [3, "3"], ["phrase", "Phrase"]]} onChange={(words) => set({ words })} />
      </Row>
      <Row label="Case">
        <Choice<CaptionCase> label="Case" value={props.style.textCase} options={[["preset", "Preset"], ["original", "As said"], ["lower", "lower"], ["upper", "UPPER"]]} onChange={(textCase) => set({ textCase })} />
      </Row>
      <Row label="Punctuation">
        <Choice<string> label="Punctuation" value={props.style.punctuation ? "keep" : "drop"} options={[["keep", "Keep"], ["drop", "Remove"]]} onChange={(value) => set({ punctuation: value === "keep" })} />
      </Row>
      <div class="flex gap-1.5">
        <Button class="flex-1" disabled={props.busy} onClick={props.onMake}>{props.hasLayer ? "Update captions" : "Make captions"}</Button>
        <Show
          when={confirmAgain()}
          fallback={<Button variant="secondary" disabled={props.busy} onClick={() => (props.dirty ? setConfirmAgain(true) : props.onTranscribeAgain())}>Transcribe again</Button>}
        >
          <Button variant="destructive" onClick={() => { setConfirmAgain(false); props.onTranscribeAgain(); }}>Drop {props.fixes || "unsaved"} fixes</Button>
        </Show>
      </div>
      <Show when={props.dirty}>
        <div class="flex items-center justify-between gap-2 text-xxs text-muted-foreground">
          <span>Unsaved fixes. Making captions saves them.</span>
          <Button size="small" variant="ghost" disabled={props.busy} onClick={props.onSave}>Save now</Button>
        </div>
      </Show>
    </section>
  );
}

function TranscriptView(props: {
  transcript: Transcript;
  fixed: ReadonlySet<string>;
  now: number;
  onSeek: (seconds: number) => void;
  onFix: (at: WordAt, text: string) => void;
  onReplace: (query: string, replacement: string) => number;
}) {
  const [query, setQuery] = createSignal("");
  const [replacement, setReplacement] = createSignal("");
  const [editing, setEditing] = createSignal<string>();
  const matches = createMemo(() => new Set(findWord(props.transcript, query()).map(key)));
  const current = createMemo(() => {
    const at = wordAt(props.transcript, props.now);
    return at ? key(at) : undefined;
  });

  const replace = () => {
    const count = props.onReplace(query(), replacement());
    if (count) {
      toast.success(`Replaced ${count} ${count === 1 ? "word" : "words"}`);
      batch(() => { setQuery(""); setReplacement(""); });
    }
  };

  return (
    <section class="flex flex-1 min-h-0 flex-col" aria-label="Transcript">
      <div class="flex items-center gap-1.5 border-b border-border px-3 py-2">
        <input
          id="captions-find"
          class="h-6 min-w-0 flex-1 rounded-md bg-muted px-2 text-foreground outline-none focus-ring"
          placeholder="Find a word…"
          aria-label="Find a word"
          value={query()}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
        <Show when={query().trim()} fallback={<span class="shrink-0 text-xxs text-muted-foreground tabular-nums">{wordCount(props.transcript)} words · {props.fixed.size} fixed</span>}>
          <input
            id="captions-replace"
            class="h-6 min-w-0 flex-1 rounded-md bg-muted px-2 text-foreground outline-none focus-ring"
            placeholder="Replace with…"
            aria-label="Replace with"
            value={replacement()}
            onInput={(event) => setReplacement(event.currentTarget.value)}
            onKeyDown={(event) => event.key === "Enter" && replace()}
          />
          <Button size="small" variant="secondary" disabled={!matches().size || !replacement().trim()} onClick={replace}>Replace {matches().size}</Button>
        </Show>
      </div>
      <div class="flex-1 min-h-0 overflow-y-auto px-3 pb-3">
        <Index each={props.transcript}>
          {(segment, s) => (
            // Off-screen segments skip layout, so a long transcript stays quick.
            <div class="grid grid-cols-[40px_1fr] gap-2 border-b border-border/60 py-1.5" style={{ "content-visibility": "auto", "contain-intrinsic-size": "auto 48px" }}>
              <button type="button" class="pt-0.5 text-left font-mono text-xxs text-muted-foreground tabular-nums hover:text-foreground focus-ring rounded" onClick={() => props.onSeek(segment().words[0]!.start)}>
                {clock(segment().words[0]!.start)}
              </button>
              <p class="m-0 text-[13px] leading-7 text-foreground/90">
                <Index each={segment().words}>
                  {(word, w) => {
                    const id = () => `${s}:${w}`;
                    return (
                      <Show
                        when={editing() === id()}
                        fallback={
                          <>
                            <span
                              role="button"
                              tabIndex={0}
                              title={`${clock(word().start)} · double-click to fix`}
                              class="cursor-pointer rounded-sm px-0.5 hover:bg-muted focus-ring"
                              classList={{
                                "bg-primary/20 text-foreground shadow-[inset_0_-2px_0_var(--primary)]": current() === id(),
                                "shadow-[inset_0_-2px_0_#f2b84b]": props.fixed.has(id()) && current() !== id(),
                                "bg-amber-400/25": matches().has(id()),
                              }}
                              onClick={() => props.onSeek(word().start)}
                              onDblClick={() => setEditing(id())}
                              onKeyDown={(event) => { if (event.key === "Enter") setEditing(id()); }}
                            >
                              {word().text}
                            </span>{" "}
                          </>
                        }
                      >
                        <WordInput
                          text={word().text}
                          onDone={(text) => {
                            setEditing(undefined);
                            if (text !== undefined) props.onFix({ segment: s, word: w }, text);
                          }}
                        />{" "}
                      </Show>
                    );
                  }}
                </Index>
              </p>
            </div>
          )}
        </Index>
      </div>
      <p class="border-t border-border px-3 py-1.5 text-xxs text-muted-foreground/80">Click a word to hear it. Double-click to fix it; clear it to remove the word.</p>
    </section>
  );
}

/** Retypes one word: Enter or leaving keeps it, Escape keeps the old one. */
function WordInput(props: { text: string; onDone: (text: string | undefined) => void }) {
  let done = false;
  const finish = (text: string | undefined) => {
    if (done) return;
    done = true;
    props.onDone(text);
  };
  return (
    <input
      ref={(element) => queueMicrotask(() => { element.focus(); element.select(); })}
      class="rounded-sm border border-primary bg-muted px-1 text-foreground outline-none"
      style={{ width: `${Math.max(4, props.text.length + 2)}ch` }}
      value={props.text}
      aria-label="Fix word"
      onKeyDown={(event) => {
        if (event.key === "Enter") finish(event.currentTarget.value);
        if (event.key === "Escape") finish(undefined);
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
    />
  );
}
