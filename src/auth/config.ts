/**
 * The mindmeld GitHub App (device-flow sign-in). The client id is public by design: device flow
 * needs no client secret, and nothing secret ships in mindmeld.
 */
export const GITHUB_CLIENT_ID = "Iv23li6Tm7NtjIm3XA0i";
/** Ignored by GitHub Apps (they use app permissions); kept for OAuth-app compatibility. */
export const GITHUB_DEVICE_SCOPE = "read:user";
