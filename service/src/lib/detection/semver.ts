/**
 * Strict semver, matching the host's `format: semver` implementation
 * (santhosh-tekuri/jsonschema `validateSemver`) rather than node-semver's loose parser.
 *
 * Differences that matter here: exactly three numeric core parts, no leading zeroes, no
 * `v` prefix, and build metadata is allowed. node-semver accepts `v1.2.3` and pads
 * missing parts, which would let the store publish manifests the host rejects.
 */
const STRICT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function isStrictSemver(value: string): boolean {
  return STRICT_SEMVER.test(value);
}
