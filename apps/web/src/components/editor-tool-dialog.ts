/** A dialog can expose its launcher to a persistent toolbar instead of drawing its own button. */
export interface EditorToolDialogProps {
  triggerRef?: (open: () => void) => void;
  onCloseAutoFocus?: (event: Event) => void;
}
