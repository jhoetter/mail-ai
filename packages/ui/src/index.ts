// Source-only barrel. Consumers (Next, Vite) resolve .tsx natively, so
// we deliberately omit file extensions here. The package.json `exports`
// points straight at this file.
export { Button } from "./primitives/button";
export { Input } from "./primitives/input";
export { Card } from "./primitives/card";
export { Dialog } from "./primitives/dialog";
export { Popover, type PopoverPlacement } from "./primitives/popover";
export {
  SegmentedControl,
  type SegmentedControlOption,
} from "./primitives/segmented-control";
export {
  ContactPicker,
  type ContactPickerValue,
  type ContactPickerResponse,
  type ContactSuggestion,
} from "./primitives/contact-picker";
export {
  RichEditor,
  type RichEditorChange,
  type RichEditorHandle,
  type RichEditorProps,
} from "./primitives/rich-editor";
export { DataTable } from "./composites/data-table";
export { PageHeader } from "./composites/page-header";
export { PageBody } from "./composites/page-body";
export { Shell, useSidebar } from "./composites/shell";
export { ThemeToggle, type ThemeToggleProps } from "./composites/theme-toggle";
export {
  DialogsProvider,
  useDialogs,
  type DialogsApi,
  type ConfirmOptions,
  type AlertOptions,
  type PromptOptions,
} from "./composites/dialogs";
export { cn } from "./lib/cn";
