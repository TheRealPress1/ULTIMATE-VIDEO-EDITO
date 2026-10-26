/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { createSignal } from "solid-js";
import { toast } from "somoto";
import { trashProject } from "./shared";

import type { ProjectInfo } from "@/projects";


type DeleteProjectDialogProps = {
  /** The projects being deleted; empty while the dialog is closed. */
  projects: ProjectInfo[];
  /** Asked for whenever the dialog should close, confirmed or not. */
  onClose(): void;
  /** The projects are in the Trash — for the list that showed them to catch up. */
  onDeleted(projects: ProjectInfo[]): void;
};

/**
 * The confirmation a deletion of projects goes through. The view holds which
 * projects are pending and renders this on them; the delete itself, and being
 * unclosable while it runs, are the dialog's own.
 */
export function DeleteProjectDialog(props: DeleteProjectDialogProps) {
  const [deleting, setDeleting] = createSignal(false);
  const multiple = () => props.projects.length > 1;

  const confirm = async () => {
    const projects = props.projects;
    if (projects.length === 0 || deleting()) return;

    setDeleting(true);
    const deleted: ProjectInfo[] = [];
    try {
      for (const project of projects) {
        await trashProject(project);
        deleted.push(project);
      }
    } catch (e) {
      toast.error("Failed to delete project", {
        description: (e as Error).message,
      });
    } finally {
      if (deleted.length > 0) props.onDeleted(deleted);
      setDeleting(false);
      props.onClose();
    }
  };

  return (
    <AlertDialog
      open={props.projects.length > 0}
      onOpenChange={(open) => {
        if (!open && !deleting()) props.onClose();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{multiple() ? `Delete ${props.projects.length} projects` : "Delete project"}</AlertDialogTitle>
          <AlertDialogDescription>
            {multiple()
              ? `${props.projects.length} projects will be moved to the Trash. You can restore them from there until the Trash is emptied.`
              : `"${props.projects[0]?.displayName ?? ""}" will be moved to the Trash. You can restore it from there until the Trash is emptied.`}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <Button variant="secondary" disabled={deleting()} onClick={props.onClose}>
            Cancel
          </Button>
          <Button variant="destructive" disabled={deleting()} onClick={confirm}>
            {deleting() ? "Deleting..." : "Delete"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
