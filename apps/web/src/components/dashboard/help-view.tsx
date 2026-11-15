/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { Show, onMount } from "solid-js";
import { toast } from "somoto";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { useAuth } from "@/context/auth";
import { feedbackStatus, refreshFeedbackStatus, startFeedback } from "@/lib/feedback";

import {
  DashboardLabelValue,
  DashboardDividedStack,
  DashboardScrollView,
  DashboardSurfaceSection,
} from "./shared";

type DashboardHelpExternalRowProps = {
  label: string;
  href: string;
};

function DashboardHelpExternalRow(props: DashboardHelpExternalRowProps) {
  return (
    <div class="flex h-4 w-full items-center gap-4 rounded-md text-xs text-foreground outline-none focus-ring">
      <span class="min-w-0 flex-1 truncate text-left">
        {props.label}
      </span>
      <a href={props.href} target="_blank">
        <Icon name="external-link" class="text-foreground" />
      </a>
    </div>
  );
}

type DashboardHelpActionRowProps = {
  label: string;
  /** Whether it leaves the app, which the icon says. */
  external: boolean;
  onSelect: () => void;
};

function DashboardHelpActionRow(props: DashboardHelpActionRowProps) {
  return (
    <button
      type="button"
      class="flex h-4 w-full items-center gap-4 rounded-md text-xs text-foreground outline-none focus-ring"
      onClick={props.onSelect}
    >
      <span class="min-w-0 flex-1 truncate text-left">
        {props.label}
      </span>
      <Icon name={props.external ? "external-link" : "ask-chat"} class="text-foreground" />
    </button>
  );
}

type DashboardHelpUserIdRowProps = {
  value: string;
  onCopy: () => void;
};

function DashboardHelpUserIdRow(props: DashboardHelpUserIdRowProps) {
  return (
    <div class="flex flex-col gap-4 sm:flex-row sm:items-center">
      <DashboardLabelValue
        label="User id"
        value={props.value}
        valueClass="truncate text-xxs"
      />
      <Button variant="secondary" onClick={props.onCopy}>
        Copy
      </Button>
    </div>
  );
}

export function DashboardHelpView() {
  const auth = useAuth();
  const userId = () => auth.user()?.id ?? "";
  // "Report issue" opens the feedback dialog once feedback is set up on this Mac, and the public issues page until then.
  onMount(() => void refreshFeedbackStatus());

  const copyUserId = async () => {
    const id = userId();
    if (!id) return;

    try {
      await navigator.clipboard.writeText(id);
      toast("Copied!", { description: "The user id has been copied to your clipboard." });
    } catch (error) {
      toast("Failed to copy", { description: error instanceof Error ? error.message : "Unknown error" });
    }
  };

  return (
    <DashboardScrollView>
      <DashboardSurfaceSection title="Resources">
        <DashboardDividedStack>
          <DashboardHelpExternalRow
            label="What's new"
            href="https://github.com/TheRealPress1/ULTIMATE-VIDEO-EDITO"
          />
          <DashboardHelpExternalRow
            label="Diffusion Studio foundation"
            href="https://github.com/diffusionstudio/editor"
          />
        </DashboardDividedStack>
      </DashboardSurfaceSection>

      <DashboardSurfaceSection title="Support">
        <DashboardDividedStack>
          <Show when={userId()}>
            <DashboardHelpUserIdRow value={userId()} onCopy={copyUserId} />
          </Show>
          <DashboardHelpActionRow
            label="Report issue"
            external={feedbackStatus()?.configured !== true}
            onSelect={() => void startFeedback()}
          />
          <DashboardHelpExternalRow
            label="Upstream documentation"
            href="https://github.com/diffusionstudio/editor"
          />
        </DashboardDividedStack>
      </DashboardSurfaceSection>

      {/* 
      <DashboardSurfaceSection title="Keyboard shortcuts">
        <DashboardInfoActionRow
          leading={<Icon name="keyboard-shortcut" class="text-foreground" />}
          title="View, search, and customize shortcuts."
          action={
            <Button variant="secondary">
              Open keyboard shortcuts...
            </Button>
          }
          layout="inline"
        />
      </DashboardSurfaceSection> 
      */}
    </DashboardScrollView>
  );
}

