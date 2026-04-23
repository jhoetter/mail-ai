// Ambient `ImportMeta` augmentation so `tsc --noEmit` over re-exported
// `apps/web/app/**` files (which read `import.meta.env.*` for the Vite
// build) compiles cleanly under this package's tsconfig. The full
// `vite/client` types only live in `apps/web` (where Vite is the
// devDep); duplicating them here would either pull a heavy types-only
// dep into the library package or split them across two configs. A
// minimal augmentation matches the shape `apps/web` actually uses.

interface ImportMetaEnv {
  readonly [key: string]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
