import js from "@eslint/js";

// Provider-specific transport modules. Allowed only inside the
// adapter folder; everywhere else has to go through the
// `@mailai/providers` ports + a registry. Keeps the hexagonal
// boundary actually enforceable instead of "vibes-based".
const PROVIDER_INTERNAL_PATTERNS = [
  // Concrete REST clients in @mailai/oauth-tokens
  "@mailai/oauth-tokens/dist/gmail*",
  "@mailai/oauth-tokens/dist/graph*",
  "@mailai/oauth-tokens/dist/send*",
  "@mailai/oauth-tokens/dist/calendar*",
  "@mailai/oauth-tokens/dist/contacts*",
  // Source-relative imports from inside the monorepo
  "**/oauth-tokens/src/gmail*",
  "**/oauth-tokens/src/graph*",
  "**/oauth-tokens/src/send*",
  "**/oauth-tokens/src/calendar*",
  "**/oauth-tokens/src/contacts*",
];

export default [
  {
    ignores: [
      "**/dist/**",
      "**/.next/**",
      "**/node_modules/**",
      "**/.turbo/**",
      "**/coverage/**",
      "infra/docker/data/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["**/*.{ts,tsx,mts,cts}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      "no-unused-vars": "off",
      "no-undef": "off",
      // Block imports of provider-specific transport modules from
      // anywhere outside the adapter layer. The adapter folder
      // (packages/oauth-tokens/src/adapters/**) is exempted via the
      // override below.
      "no-restricted-imports": [
        "error",
        {
          patterns: PROVIDER_INTERNAL_PATTERNS.map((p) => ({
            group: [p],
            message:
              "Import a provider-agnostic port from @mailai/providers and a registry instead. Direct calls into gmail/graph/send/calendar/contacts modules are only allowed inside packages/oauth-tokens/src/adapters/.",
          })),
        },
      ],
    },
  },
  {
    // Adapters are the one place that's allowed to talk to the
    // concrete REST clients. They sit on the boundary between the
    // provider-agnostic port and the network.
    files: [
      "packages/oauth-tokens/src/adapters/**/*.{ts,tsx}",
      "packages/oauth-tokens/src/**/*.test.ts",
    ],
    rules: {
      "no-restricted-imports": "off",
    },
  },
];
