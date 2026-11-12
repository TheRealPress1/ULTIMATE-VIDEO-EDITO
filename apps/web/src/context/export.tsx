/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show, createContext, createSignal, useContext, onCleanup, onMount } from "solid-js";
import { toast } from "somoto";
import { canEncodeVideo } from "mediabunny";
import { useWorld } from "@diffusionstudio/koota-solid";
import { computeOutputSize, createImageEncoder } from "@diffusionstudio/encoder";
import { Computed, FrameRate, Workarea, getActiveEntity, store } from "@diffusionstudio/runtime";
import { assert, isInputTarget } from "@/utils";
import { useEngineContext } from "@/engine";
import { createCapture } from "@/engine/capture";
import { useProject } from "@/context/project";
import { mainBridge } from "@/lib/ipc";
import { MAIN_CHANNELS } from "@desktop/main-channels";
import { ElectronWritableFileHandle } from "@/lib/electron-file-writable";
import { useProjectConfig } from "@/engine/project-config";
import { ExportComplete, ExportSetup } from "@/components/sidebar-right/inspector/export-dialogs";
import { BackgroundExportProgress, ExportProgress } from "@/components/sidebar-right/inspector/export-progress";
import { renderScene, renderOverlay, cancelRender, completedExport, dismissCompletedExport, type ExportConfig } from "@/context/render";
import {
  MIME_TYPES,
  getDefaultExportTemplate,
} from "@/components/sidebar-right/inspector/export-templates";

import type { Entity } from "koota";
import type { JSX, Accessor } from "solid-js";

type ExportContextValue = {
  exportScene: (scene: Entity, config?: ExportConfig) => Promise<void>;
  /** Writes the frame at the active scene's playhead as a PNG, at the scene's own size. */
  exportCurrentFrame: () => Promise<void>;
  /** Writes the frame at `scene`'s playhead as a PNG, its shorter side `resolution` px (the scene's own when left out). */
  exportFrame: (scene: Entity, resolution?: number) => Promise<void>;
  exporting: Accessor<boolean>;
};

const ExportContext = createContext<ExportContextValue>();

export function ExportProvider(props: { children: JSX.Element }) {
  const engine = useEngineContext();
  const world = useWorld();
  const project = useProject();

  const projectConfig = useProjectConfig();
  const [choosingTarget, setChoosingTarget] = createSignal(false);
  const [request, setRequest] = createSignal<{ scene: Entity; config: ExportConfig } | null>(null);
  const exporting = () => choosingTarget() || !!renderOverlay();
  /** A draft an agent is rendering behind a corner indicator, not a full-window export. */
  const drafting = () => !!renderOverlay()?.background;

  const exportScene: ExportContextValue["exportScene"] = async (scene, config) => {
    if (!scene?.isAlive()) return;
    if (drafting()) {
      toast("A draft is still rendering", { description: "An agent is checking its work. Try again in a few seconds." });
      return;
    }
    if (exporting()) return;
    const computed = scene.get(Computed);
    const workarea = scene.get(Workarea);
    const frames = workarea ? workarea.end - workarea.start : computed?.duration ?? 0;
    if (frames <= 0) {
      toast.error("Nothing to export", { description: "Add footage to the scene or extend its duration first." });
      return;
    }
    setRequest({ scene, config: config ?? projectConfig()?.exportOf(scene) ?? getDefaultExportTemplate() });
  };

  const runExport = async (scene: Entity, config: ExportConfig) => {
    if (!scene?.isAlive() || exporting()) return;
    setChoosingTarget(true);
    setRequest(null);
    let nativeTarget: ElectronWritableFileHandle | undefined;
    try {
      const format = config.format ?? "mp4";
      const mimeType = MIME_TYPES[format];
      const videoEnabled = format !== "ogg" && config.video?.enabled !== false;
      if (!videoEnabled && config.audio?.enabled === false) {
        throw new Error("Enable video or audio in the export settings first.");
      }

      // Fail before choosing a file when the requested encoder is unavailable.
      if (videoEnabled) {
        const computed = scene.get(Computed);
        const codec = config.video?.codec ?? "avc";
        const { width, height } = computeOutputSize(
          computed?.width || 1920,
          computed?.height || 1080,
          config.video?.resolution ?? 1080,
        );
        if (!await canEncodeVideo(codec, { width, height, bitrate: config.video?.bitrate ?? 10e6 })) {
          throw new Error(
            `Cannot encode ${codec.toUpperCase()} at ${width}×${height}. ` +
            "Choose a lower resolution, a lower bitrate, or another codec.",
          );
        }
      }

      const name = project.name().replace(/[^a-z0-9._-]+/gi, "-").toLowerCase() || "cutroom-export";
      let target: FileSystemFileHandle | ElectronWritableFileHandle;
      let output: { name: string; path?: string };
      if (window.desktop) {
        const path = await mainBridge.call(MAIN_CHANNELS.EXPORT_PICK_SAVE, { suggestedName: `${name}.${format}`, format });
        if (!path) return;
        nativeTarget = new ElectronWritableFileHandle(path);
        target = nativeTarget;
        output = { name: path.split(/[\\/]/).pop()!, path };
      } else {
        target = await window.showSaveFilePicker({
          suggestedName: `${name}.${format}`,
          types: [{ description: format, accept: { [mimeType]: [`.${format}`] } as Record<`${string}/${string}`, `.${string}`[]> }],
        });
        output = { name: target.name };
      }

      // Keep the next UI export and the agent's export tool on the same settings.
      await projectConfig()?.setExport(scene, {
        ...projectConfig()?.exportOf(scene),
        format: config.format,
        video: config.video,
        audio: config.audio,
      });
      const result = await renderScene(engine, { scene, target, config, dir: project.dir(), source: "ui", output });
      if (result.type === "error") throw result.error;
      if (result.type === "canceled") {
        toast("Export canceled", { description: "The exported file was not saved." });
      }
    } catch (error) {
      if ((error as Error).name !== "AbortError") {
        console.error("Export failed:", error);
        toast.error("Export failed", { description: (error as Error).message });
      }
    } finally {
      await nativeTarget?.dispose().catch((error) => console.error("Export cleanup failed:", error));
      setChoosingTarget(false);
    }
  };

  const exportCurrentFrame: ExportContextValue["exportCurrentFrame"] = async () => {
    const scene = getActiveEntity(world);
    if (scene === null) {
      toast("No active scene to export");
      return;
    }
    await exportFrame(scene);
  };

  const exportFrame: ExportContextValue["exportFrame"] = async (scene, resolution) => {
    if (!scene?.isAlive()) return;

    // The frame under the playhead, counted the way the image encoder counts:
    // from the export's first frame, the work area's start.
    const computed = scene.get(Computed);
    const workarea = scene.get(Workarea);
    const start = workarea?.start ?? 0;
    const end = workarea?.end ?? computed?.duration ?? 0;
    const playhead = store(world, Computed).localTime[scene.id()] ?? 0;
    const frame = Math.max(0, Math.min(playhead, end - 1) - start);

    // The encoder sizes by height; a resolution names the shorter side.
    const { height } = computeOutputSize(computed?.width || 1920, computed?.height || 1080, resolution);

    const name = project.name().replace(/\s+/g, "-").toLowerCase();

    let target: FileSystemFileHandle;
    try {
      target = await window.showSaveFilePicker({
        suggestedName: `${name}.png`,
        types: [{ description: "png", accept: { "image/png": [".png"] } }],
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      toast.error("Failed to start export", { description: (e as Error).message });
      return;
    }

    const progress = toast.loading("Exporting image...");
    let capture: Awaited<ReturnType<typeof createCapture>> | undefined;
    try {
      capture = await createCapture(world, scene, { dir: project.dir() });
      const encoder = await createImageEncoder(capture.world, { frames: [frame], resolution: height });
      const result = await encoder.render();
      if (result.type === "canceled") {
        toast.dismiss(progress);
        return;
      }
      if (result.type === "error") throw result.error;

      const writable = await target.createWritable();
      // Copied onto a plain ArrayBuffer, which is what a file write takes.
      await writable.write(new Uint8Array(result.data[0]!.png));
      await writable.close();
      toast.dismiss(progress);
      toast("Export complete", { description: "Your image has been successfully exported" });
    } catch (e) {
      console.error("Image export failed:", e);
      toast.dismiss(progress);
      toast.error("Export failed", { description: (e as Error).message });
    } finally {
      capture?.dispose();
    }
  };

  const exportActiveScene = () => {
    const scene = getActiveEntity(world);
    if (scene === null) {
      return toast("No active scene to export");
    }
    void exportScene(scene);
  };

  /**
   * Export is the provider's command, so its keys are bound here rather than
   * in the engine's shortcut table: ⌘E writes the active scene, ⇧⌘E the frame
   * at its playhead — the same two the File menu lists.
   */
  const handleShortcut = (event: KeyboardEvent) => {
    if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== "e") return;
    if (isInputTarget(event)) return;

    event.preventDefault();
    if (event.shiftKey) void exportCurrentFrame();
    else exportActiveScene();
  };

  onMount(() => window.addEventListener("keydown", handleShortcut));
  onCleanup(() => {
    window.removeEventListener("keydown", handleShortcut);
    dismissCompletedExport();
  });

  return (
    <ExportContext.Provider value={{ exportScene, exportCurrentFrame, exportFrame, exporting }}>
      {props.children}
      <Show when={request()} keyed>
        {(pending) => {
          const computed = pending.scene.get(Computed);
          const workarea = pending.scene.get(Workarea);
          const fps = world.get(FrameRate)?.value || 30;
          return <ExportSetup
            config={pending.config}
            width={computed?.width || 1920}
            height={computed?.height || 1080}
            duration={(workarea ? workarea.end - workarea.start : computed?.duration ?? 0) / fps}
            fps={fps}
            onClose={() => setRequest(null)}
            onExport={(config) => void runExport(pending.scene, config)}
          />;
        }}
      </Show>
      <Show when={!renderOverlay() && completedExport()} keyed>
        {(result) => <ExportComplete result={result} onClose={dismissCompletedExport} />}
      </Show>
      <ExportProgress
        open={!!renderOverlay() && !drafting()}
        phase={renderOverlay()?.phase ?? "preparing"}
        name={renderOverlay()?.name}
        audioOnly={renderOverlay()?.audioOnly ?? false}
        progress={renderOverlay()?.progress ?? 0}
        remaining={renderOverlay()?.remaining}
        onCancel={cancelRender}
      />
      <BackgroundExportProgress
        open={drafting()}
        phase={renderOverlay()?.phase ?? "preparing"}
        name={renderOverlay()?.name}
        audioOnly={renderOverlay()?.audioOnly ?? false}
        progress={renderOverlay()?.progress ?? 0}
        remaining={renderOverlay()?.remaining}
        onCancel={cancelRender}
      />
    </ExportContext.Provider>
  );
}

export function useExport() {
  const ctx = useContext(ExportContext);
  assert(ctx, "useExport must be used within ExportProvider");
  return ctx;
}
