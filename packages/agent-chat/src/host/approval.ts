/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { newItemId } from "./harness";

import type { QuestionBox } from "./harness";

export type ApprovalDecision = "accept" | "decline" | "cancel";

/** Host audit trail only: never log tool input, credentials, command text or file contents. */
export function auditAutomaticApproval(provider: 'claude' | 'codex', tool: string, scope: 'project-file' | 'local-editor-tool' | 'project-sandbox'): void {
  console.info('[uve-permissions]', JSON.stringify({ provider, tool, decision: 'auto-allow', scope }));
}

/** Single-use approval through the existing question card. No implicit grants. */
export async function requestApproval(
  box: QuestionBox | null,
  title: string,
  details: unknown,
  signal?: AbortSignal,
): Promise<ApprovalDecision> {
  if (!box || signal?.aborted) return "cancel";
  let preview: string;
  try {
    preview = typeof details === "string" ? details : JSON.stringify(details, null, 2);
  } catch {
    return "decline";
  }
  // Never offer to approve an action whose details the card cannot display.
  if (!preview || preview.length > 24_000) return "decline";
  const id = newItemId("permission");
  const response = await box.ask([{
    id,
    header: "Permission",
    question: `${title}\n\n${preview}`,
    options: [
      { label: "Deny", description: "Do not perform this action." },
      { label: "Allow once", description: "Approve only the request shown above." },
    ],
    multiSelect: false,
    allowOther: false,
    secret: false,
  }], signal);
  if (signal?.aborted) return "cancel";
  if (response === "cancel") return "cancel";
  if (response === "skip") return "decline";
  const answer = response.answers?.[id];
  return Array.isArray(answer) && answer.length === 1 && answer[0] === "Allow once" ? "accept" : "decline";
}
