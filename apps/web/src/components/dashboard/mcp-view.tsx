/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { For, Match, Show, Switch, createResource, createSignal, onCleanup } from "solid-js";
import { toast } from "somoto";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Switch as Toggle, SwitchControl, SwitchInput, SwitchThumb } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  AGENT_ICONS,
  applyMcp,
  fetchCliStatus,
  fetchMcpStatus,
  installCli,
  uninstallCli,
  type AgentId,
  type McpAgentStatus,
} from "@/lib/mcp";
import { isDesktop } from "@/projects";
import { chatState, ensureConnected, refreshHarnesses } from "@/agent-chat/store";
import type { HarnessId, HarnessInfo } from "@diffusionstudio/agent-chat";

import {
  DashboardDividedStack,
  DashboardInfoActionRow,
  DashboardScrollView,
  DashboardSurfaceCard,
  DashboardSurfaceSection,
  DashboardTitledSection,
} from "./shared";

const MCP_DOCS_URL = "https://modelcontextprotocol.io/docs/2026-07-28/develop/connect-local-servers";

// --- In-app agents -----------------------------------------------------------

const IN_APP_AGENTS: { id: HarnessId; label: string; login: string }[] = [
  { id: "claude", label: "Claude Code", login: "claude auth login" },
  { id: "codex", label: "Codex", login: "codex login" },
];

function DashboardInAppAgentsSection() {
  ensureConnected();
  const connected = () => chatState.connection === "open";
  const checking = () => chatState.harnesses.some((harness) => harness.status === "checking");
  const statusLabel = (harness: HarnessInfo | undefined): string => {
    if (!isDesktop()) return "Desktop required";
    if (!connected()) return chatState.connection === "connecting" ? "Connecting…" : "Host unavailable";
    if (!harness) return "Checking…";
    switch (harness.status) {
      case "ready": return "Ready";
      case "signed-out": return "Sign in required";
      case "not-installed": return "Not installed";
      case "checking": return "Checking…";
      default: return "Unavailable";
    }
  };
  const copyLogin = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      toast("Sign-in command copied");
    } catch (error) {
      toast.error("Could not copy command", { description: (error as Error).message });
    }
  };

  return (
    <DashboardTitledSection
      title="In-app agents"
      description="Use Claude Code and Codex with the accounts you already have."
      action={<Button variant="link" class="h-4" disabled={!connected() || checking()} onClick={() => refreshHarnesses(true)}>Refresh</Button>}
    >
      <DashboardSurfaceCard class="flex flex-col gap-3">
        <DashboardDividedStack>
          <For each={IN_APP_AGENTS}>
            {(provider) => {
              const harness = () => chatState.harnesses.find((entry) => entry.id === provider.id);
              const ready = () => connected() && harness()?.status === "ready";
              return (
                <div class="flex flex-col gap-3">
                  <DashboardInfoActionRow
                    layout="inline"
                    leadingSize="sm"
                    title={provider.label}
                    leading={<Icon name={provider.id === "claude" ? "claude-code" : "codex"} class="text-foreground" />}
                    description={ready() ? `${harness()!.models.length} models available${harness()?.version ? ` · v${harness()!.version}` : ""}` : !isDesktop() ? "Open Blackout desktop to detect your installed agent." : harness()?.detail ?? "Checking the local agent host."}
                    action={<span class="shrink-0 rounded-full px-2 py-1 text-[10px]" classList={{ "bg-success-accent text-success-accent-foreground": ready(), "bg-accent text-muted-foreground": !ready() }}>{statusLabel(harness())}</span>}
                  />
                  <Show when={connected() && harness()?.status === "signed-out"}>
                    <div class="flex items-center gap-3 rounded-md border border-border px-3 py-2">
                      <p class="min-w-0 flex-1 text-xs leading-5 text-muted-foreground">In your terminal, run <code class="select-text text-foreground">{provider.login}</code>, sign in, then refresh.</p>
                      <Button variant="secondary" size="small" onClick={() => void copyLogin(provider.login)}>Copy command</Button>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </DashboardDividedStack>
      </DashboardSurfaceCard>
      <p class="px-2 pt-3 text-xs leading-5 text-muted-foreground">In-app conversations connect to Blackout’s editing tools automatically. No external MCP registration is needed.</p>
    </DashboardTitledSection>
  );
}

// --- External agents ---------------------------------------------------------

type AgentRowProps = {
  agent: McpAgentStatus;
  /** The state the switch is moving to while a write is in flight. */
  pending: boolean | undefined;
  onChange: (connected: boolean) => void;
};

function AgentRow(props: AgentRowProps) {
  const checked = () => props.pending ?? props.agent.connected;

  return (
    <DashboardInfoActionRow
      layout="inline"
      leadingSize="sm"
      title={props.agent.label}
      leading={<Icon name={AGENT_ICONS[props.agent.id]} class="text-foreground" />}
      action={
        <Toggle
          checked={checked()}
          disabled={props.pending !== undefined}
          onChange={props.onChange}
          class="flex shrink-0 items-center"
        >
          <SwitchInput aria-label={`Connect ${props.agent.label}`} />
          <SwitchControl variant="compact">
            <SwitchThumb variant="compact" />
          </SwitchControl>
        </Toggle>
      }
    />
  );
}

function DashboardAgentsSection() {
  const [status, { refetch }] = createResource(fetchMcpStatus);
  const [pending, setPending] = createSignal<Partial<Record<AgentId, boolean>>>({});

  const labelOf = (id: AgentId) => status()?.agents.find((agent) => agent.id === id)?.label ?? id;

  /** Every agent not yet connected. */
  const connectable = () => (status()?.agents ?? []).filter((agent) => !agent.connected);

  /**
   * Writes the change straight into the agents' configs — a switch is not a
   * draft. Whatever fails snaps back, with the reason in a toast.
   */
  const apply = async (add: AgentId[], remove: AgentId[]) => {
    if (add.length + remove.length === 0) return;
    setPending((current) => ({
      ...current,
      ...Object.fromEntries(add.map((id) => [id, true])),
      ...Object.fromEntries(remove.map((id) => [id, false])),
    }));
    try {
      const result = await applyMcp({ add, remove });
      const changed = result.added.length + result.removed.length;
      if (result.failures.length > 0) {
        toast.error(changed > 0 ? "Some agents could not be updated" : "Agents could not be updated", {
          description: result.failures.map((failure) => `${labelOf(failure.id)}: ${failure.error}`).join("\n"),
        });
      }
    } catch (e) {
      toast.error("Could not update the agents", { description: (e as Error).message });
    } finally {
      await refetch();
      setPending((current) => {
        const next = { ...current };
        for (const id of [...add, ...remove]) delete next[id];
        return next;
      });
    }
  };

  const setConnected = (agent: McpAgentStatus, connected: boolean) =>
    apply(connected ? [agent.id] : [], connected ? [] : [agent.id]);

  const enableAll = () => apply(connectable().map((agent) => agent.id), []);

  return (
    <DashboardTitledSection
      title="External app connections (optional)"
      description="Register Blackout in other apps so you can edit videos from their own conversations. These switches update each app’s MCP configuration."
      action={
        <Button variant="link" class="h-4" disabled={connectable().length === 0} onClick={enableAll}>
          Enable all
        </Button>
      }
    >
      <DashboardSurfaceCard class="flex flex-col gap-3">
        <Show
          when={status()}
          fallback={<p class="text-xs text-muted-foreground">Checking agents...</p>}
        >
          {(current) => (
            <DashboardDividedStack>
              <For each={current().agents}>
                {(agent) => (
                  <AgentRow
                    agent={agent}
                    pending={pending()[agent.id]}
                    onChange={(connected) => void setConnected(agent, connected)}
                  />
                )}
              </For>
            </DashboardDividedStack>
          )}
        </Show>
      </DashboardSurfaceCard>
    </DashboardTitledSection>
  );
}

// --- MCP server --------------------------------------------------------------

const COPIED_LABEL_MS = 2000;

function DashboardMcpServerSection() {
  const [status] = createResource(fetchMcpStatus);
  const [copied, setCopied] = createSignal(false);
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(copiedTimer));

  const copy = async () => {
    const url = status()?.url;
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      // The button itself says so for a moment, then goes back to its label.
      setCopied(true);
      clearTimeout(copiedTimer);
      copiedTimer = setTimeout(() => setCopied(false), COPIED_LABEL_MS);
    } catch (e) {
      toast.error("Failed to copy", { description: (e as Error).message });
    }
  };

  return (
    <DashboardTitledSection title="MCP Server">
      <DashboardSurfaceCard class="flex flex-col gap-3">
        <DashboardInfoActionRow
          layout="inline"
          leadingSize="sm"
          title="Blackout MCP"
          leading={<Icon name="ai-mcp-cli" class="text-foreground" />}
          description="Connect any other agent that supports MCP over Streamable HTTP."
          action={
            <div class="flex shrink-0 items-center gap-2">
              <div class="flex h-7 w-41 items-center rounded-md bg-input px-2">
                <span class="min-w-0 flex-1 truncate text-xs text-foreground">{status()?.url ?? "..."}</span>
              </div>
              <Button variant="secondary" disabled={!status()} onClick={copy}>
                {copied() ? "Copied!" : "Copy URL"}
              </Button>
            </div>
          }
        />
      </DashboardSurfaceCard>
      <p class="px-2 pt-3 text-xs text-muted-foreground">
        <span>Available locally while Blackout is running. </span>
        <a href={MCP_DOCS_URL} target="_blank" class="text-primary hover:underline">
          What is MCP?
        </a>
      </p>
    </DashboardTitledSection>
  );
}

// --- CLI ---------------------------------------------------------------------

function DashboardCliSection() {
  const [status, { refetch }] = createResource(fetchCliStatus);
  const [busy, setBusy] = createSignal(false);

  const handleInstall = async () => {
    setBusy(true);
    try {
      const result = await installCli();
      if (result.status === "installed") {
        toast("CLI installed", { description: "Run cutroom --help in a terminal to get started." });
      }
      if (result.status === "error") {
        toast.error("Could not install the CLI", { description: result.error });
      }
    } catch (e) {
      toast.error("Could not install the CLI", { description: (e as Error).message });
    } finally {
      setBusy(false);
      void refetch();
    }
  };

  const handleUninstall = async () => {
    setBusy(true);
    try {
      const result = await uninstallCli();
      if (result.status === "removed") toast("CLI uninstalled");
      if (result.status === "error") toast.error("Could not uninstall the CLI", { description: result.error });
    } catch (e) {
      toast.error("Could not uninstall the CLI", { description: (e as Error).message });
    } finally {
      setBusy(false);
      void refetch();
    }
  };

  return (
    <DashboardSurfaceSection
      title="CLI"
      description="Give agents access to Blackout through terminal commands."
    >
      <DashboardInfoActionRow
        layout="inline"
        leadingSize="sm"
        title="cutroom CLI"
        leading={<Icon name="dapi-cli" class="text-foreground" />}
        description="Blackout’s command-line tool for accessing its media tools and managing projects."
        action={
          <Switch>
            <Match when={!status()}>
              <Button variant="secondary" disabled>
                Install
              </Button>
            </Match>
            <Match when={status()?.installed && status()?.managed}>
              <Tooltip>
                <TooltipTrigger as={Button} variant="secondary" disabled={busy()} onClick={handleUninstall}>
                  Uninstall
                </TooltipTrigger>
                <TooltipContent>Installed at {status()?.path}</TooltipContent>
              </Tooltip>
            </Match>
            <Match when={status()?.installed}>
              <Tooltip>
                <TooltipTrigger as={Button} variant="on">
                  Installed
                </TooltipTrigger>
                <TooltipContent>Found at {status()?.path}. This command is not managed by Blackout.</TooltipContent>
              </Tooltip>
            </Match>
            <Match when={!status()?.available}>
              <span title="CLI installation isn’t available in this build.">
                <Button variant="secondary" disabled>Unavailable</Button>
              </span>
            </Match>
            <Match when={true}>
              <Button variant="secondary" disabled={busy()} onClick={handleInstall}>
                {busy() ? "Installing…" : "Install"}
              </Button>
            </Match>
          </Switch>
        }
      />
    </DashboardSurfaceSection>
  );
}

export function DashboardMcpView() {
  return (
    <DashboardScrollView>
      <DashboardInAppAgentsSection />
      <Show
        when={isDesktop()}
        fallback={
          <DashboardSurfaceSection title="External connections">
            <p class="text-xs text-muted-foreground">
              External MCP connections and the command-line tool are available in Blackout desktop.
            </p>
          </DashboardSurfaceSection>
        }
      >
        <DashboardAgentsSection />
        <DashboardMcpServerSection />
        <DashboardCliSection />
      </Show>
    </DashboardScrollView>
  );
}
