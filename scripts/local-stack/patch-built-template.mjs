// Points a built SAM template's Lambdas at the local AWS substitutes.
//
// `sam local --env-vars` only fills environment variables that the template
// already declares, and `--container-env-vars` applies only to debug sessions,
// so the endpoint overrides have to come from the template itself. Patching the
// *built* template (.aws-sam/build, generated and gitignored) keeps the
// deployable template.yaml untouched.
//
// Re-run after every `sam build`. Idempotent.
// Usage: node patch-built-template.mjs <path-to-built-template.yaml>
import { readFileSync, writeFileSync } from "node:fs";

const MARKER = "# lcw-local-stack: injected environment";
const ENV_LINES = [
  `    Environment:`,
  `      Variables:`,
  `        ${MARKER}`,
  `        AWS_ENDPOINT_URL_DYNAMODB: http://lcw-dynamodb:8000`,
  `        AWS_ENDPOINT_URL_S3: http://lcw-minio:9000`,
  `        AWS_ACCESS_KEY_ID: localtest`,
  `        AWS_SECRET_ACCESS_KEY: localtest`,
  `        AWS_REGION: us-east-1`,
  `        TABLE_NAME: wallet-test`,
];

const path = process.argv[2];
if (!path) {
  console.error("usage: node patch-built-template.mjs <path-to-built-template.yaml>");
  process.exit(1);
}

const template = readFileSync(path, "utf8");
if (template.includes(MARKER)) {
  console.log(`already patched: ${path}`);
  process.exit(0);
}

let patched;
if (/^Globals:\n  Function:\n/m.test(template)) {
  // Extend the existing Globals.Function block. SAM merges these variables with
  // each function's own Environment.Variables, so per-function values survive.
  patched = template.replace(
    /^Globals:\n  Function:\n/m,
    `Globals:\n  Function:\n${ENV_LINES.join("\n")}\n`
  );
} else if (/^Resources:$/m.test(template)) {
  // No Globals section at all: add one immediately before Resources.
  patched = template.replace(
    /^Resources:$/m,
    `Globals:\n  Function:\n${ENV_LINES.join("\n")}\nResources:`
  );
} else {
  console.error(`could not find Globals.Function or Resources in ${path}`);
  process.exit(1);
}

writeFileSync(path, patched);
console.log(`patched: ${path}`);
