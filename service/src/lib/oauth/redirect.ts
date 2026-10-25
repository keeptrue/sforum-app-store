/**
 * The one OAuth2 redirect URI this store ever registers.
 *
 * The admin console shows this string for copying into SForum, and the login start route
 * sends it to the provider — both must be the same bytes, because the provider matches
 * redirect URIs exactly (`matchRedirectURI` in `sforum-oauth2-provider/backend/oauth2.go`):
 * no wildcards, no prefix matching, no fragment, and a trailing slash is a different URI.
 */
export function sforumCallbackUrl(publicUrl: string): string {
  return `${publicUrl.trim().replace(/\/+$/, "")}/api/auth/sforum/callback`;
}
