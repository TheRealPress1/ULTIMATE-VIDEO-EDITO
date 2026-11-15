/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import { useCommand } from "@/context/commands";
import { startFeedback } from "@/lib/feedback";

/** Opens the feedback dialog, or the public issues page when feedback is not set up on this Mac. */
export function SendFeedbackCommand() {
  useCommand({
    id: "send-feedback",
    title: "Send feedback",
    group: "View",
    icon: "ask-chat",
    keywords: ["report", "issue", "bug", "idea", "suggest", "problem", "premiere", "tester"],
    order: 2,
    run: () => void startFeedback("feedback"),
  });

  return null;
}
