// Ambient type stubs for `@officeai/react-editors`.
//
// The package is not published to npm — it ships as a tarball staged
// under `node_modules/@officeai/react-editors/` by the root postinstall
// (`scripts/ensure-officeai-react-editors.cjs`). When the staging fails
// (offline, lockfile placeholder, or the host hasn't installed it), the
// dynamic imports in `AttachmentViewer.tsx` fall back to a no-op via
// try/catch, so we only need TypeScript to know the imports exist.
//
// We deliberately type the components as `any`-shaped React function
// components — the real types live in the upstream package and would
// pull in too many transitive types just to satisfy a viewer fallback.
// Tightening these signatures should happen if the embed grows real
// orchestration logic around the editors.

interface OfficeEditorProps {
  url: string;
  readOnly?: boolean;
  [key: string]: unknown;
}

declare module "@officeai/react-editors/components/pdf" {
  import type { ComponentType } from "react";
  export const PdfEditor: ComponentType<OfficeEditorProps>;
}

declare module "@officeai/react-editors/components/docx" {
  import type { ComponentType } from "react";
  export const DocxEditor: ComponentType<OfficeEditorProps>;
}

declare module "@officeai/react-editors/components/xlsx" {
  import type { ComponentType } from "react";
  export const XlsxEditor: ComponentType<OfficeEditorProps>;
}

declare module "@officeai/react-editors/components/pptx" {
  import type { ComponentType } from "react";
  export const PptxEditor: ComponentType<OfficeEditorProps>;
}
