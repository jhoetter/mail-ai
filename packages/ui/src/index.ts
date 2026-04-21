// Source-only barrel. Consumers (Next, Vite) resolve .tsx natively, so
// we deliberately omit file extensions here. The package.json `exports`
// points straight at this file.
export { Button } from "./primitives/button";
export { Input } from "./primitives/input";
export { Card } from "./primitives/card";
export { Dialog } from "./primitives/dialog";
export { DataTable } from "./composites/data-table";
export { PageHeader } from "./composites/page-header";
export { Shell } from "./composites/shell";
export { ThemeToggle } from "./composites/theme-toggle";
export { cn } from "./lib/cn";
