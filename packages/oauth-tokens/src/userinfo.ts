// Provider userinfo lookups, surfaced to the public API so the OAuth
// callback handler can resolve "which email did the user just
// authorize?" without reaching into provider-specific transport
// modules.
//
// Implementation lives in gmail.ts / graph.ts because both endpoints
// are vendored alongside the rest of each provider's REST client; we
// only want the userinfo helpers (and not the message-fetch ones)
// exposed here.

export { fetchGoogleUserInfo, type GoogleUserInfo } from "./gmail.js";
export {
  fetchMicrosoftUserInfo,
  type MicrosoftUserInfo,
} from "./graph.js";
