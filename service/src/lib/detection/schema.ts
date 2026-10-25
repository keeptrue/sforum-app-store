import Ajv2020, { type ErrorObject, type ValidateFunction } from "ajv/dist/2020";
import addFormats from "ajv-formats";

import manifestV3Schema from "./schema/manifest-v3.schema.json";
import { isStrictSemver } from "./semver";

/**
 * Structural gate for `sforum.extension.json`, compiled from the schema the host itself
 * runs at install time (`apps/api/app/Support/ExtensionManifest/json_schema.go`).
 *
 * The vendored copy is byte-identical to the host file; `manifest:check` guards it. Do not
 * hand-edit `schema/manifest-v3.schema.json` — re-sync it instead.
 */
export type SchemaIssue = {
  /** JSON pointer into the manifest, e.g. `/author/name` (empty for the document root). */
  path: string;
  keyword: string;
  message: string;
  /** Missing property name for `required` failures, otherwise undefined. */
  missingProperty?: string;
};

export class ManifestSchemaError extends Error {
  readonly issue: SchemaIssue;

  constructor(issue: SchemaIssue) {
    super(`${issue.path || "/"}: ${issue.message}`);
    this.name = "ManifestSchemaError";
    this.issue = issue;
  }
}

let validator: ValidateFunction | null = null;

function compile(): ValidateFunction {
  if (validator) return validator;

  const ajv = new Ajv2020({
    allErrors: false,
    strict: false,
    validateFormats: true,
    allowUnionTypes: true,
  });
  addFormats(ajv);
  // The host registers both pointer formats with a field-budget implementation
  // (`route_mutable_fields.go`) that the store does not re-implement. Accepting the
  // string here keeps the store from rejecting manifests it cannot judge; the gap is
  // recorded in knowledge/decisions/2026-10-25-manifest-contract-alignment.md.
  ajv.addFormat("sforum-route-mutable-request-pointer", {
    type: "string",
    validate: () => true,
  });
  ajv.addFormat("sforum-route-mutable-response-pointer", {
    type: "string",
    validate: () => true,
  });
  // `format: semver` is a host extension; mirror its strict parser exactly.
  ajv.addFormat("semver", {
    type: "string",
    validate: (value: string) => isStrictSemver(value),
  });

  validator = ajv.compile(manifestV3Schema);
  return validator;
}

function firstIssue(errors: ErrorObject[] | null | undefined): SchemaIssue {
  const error = errors?.[0];
  if (!error) {
    return { path: "", keyword: "schema", message: "manifest does not match the schema" };
  }
  const params = error.params as { missingProperty?: string };
  return {
    path: error.instancePath,
    keyword: error.keyword,
    message: error.message ?? error.keyword,
    missingProperty: params.missingProperty,
  };
}

/** Throws `ManifestSchemaError` when `input` is not a schema-valid V3 manifest. */
export function assertManifestSchema(input: unknown): void {
  const validate = compile();
  if (validate(input)) return;
  throw new ManifestSchemaError(firstIssue(validate.errors));
}

export const MANIFEST_SCHEMA_ID = "https://sforum.dev/schemas/extensions/manifest-v3.schema.json";
