// Points a built SAM template's Lambdas at the local AWS substitutes.
//
// `sam local --env-vars` only fills environment variables that the template
// already declares, and `--container-env-vars` applies only to debug sessions,
// so the endpoint overrides have to come from the template itself. Patching the
// *built* template (.aws-sam/build, generated and gitignored) keeps the
// source template.yaml untouched.
//
// That is not the same as being deploy-safe. `sam deploy` defaults to
// .aws-sam/build/template.yaml, and neither back end pins `template_file`, so a
// `sam deploy` after using the local stack would pick up a patched template
// carrying container-name endpoints and `localtest` credentials.
// CloudFormation rejects the reserved AWS_* environment keys, so it fails
// rather than deploying something wrong -- but it fails confusingly. Re-run
// `sam build` before any deploy to discard the patch.
//
// Re-run after every `sam build`. Idempotent.
// Usage: node patch-built-template.mjs <path-to-built-template.yaml>
//
// The edit is indentation-aware rather than a regex replace. SAM templates
// carry CloudFormation shorthand tags (!Ref, !Sub, !GetAtt) that a plain YAML
// parser rejects, so this walks the block structure by indentation instead:
// it merges into an existing Globals.Function.Environment.Variables block if
// there is one, and only creates the parts that are missing. An earlier version
// appended a second `Environment:` key, which is legal-looking YAML whose
// duplicate key SAM resolves to the *last* occurrence -- silently dropping
// every override and sending the Lambdas at real AWS.
import { readFileSync, writeFileSync } from "node:fs";

const MARKER = "lcw-local-stack: injected environment";

// The overrides. Order is stable so a patched template diffs cleanly.
const VARS = {
  AWS_ENDPOINT_URL_DYNAMODB: "http://lcw-dynamodb:8000",
  AWS_ENDPOINT_URL_S3: "http://lcw-minio:9000",
  AWS_ACCESS_KEY_ID: "localtest",
  AWS_SECRET_ACCESS_KEY: "localtest",
  AWS_REGION: "us-east-1",
  TABLE_NAME: "wallet-test",
};

const indentOf = (line) => line.length - line.trimStart().length;
const isBlank = (line) => line.trim() === "";
const isComment = (line) => line.trimStart().startsWith("#");

// Index of the line holding `key:` at exactly `indent` spaces, searching only
// within [from, to). Skips blanks and comments.
function findKey(lines, key, indent, from, to) {
  for (let i = from; i < to; i++) {
    const line = lines[i];
    if (isBlank(line) || isComment(line)) continue;
    if (indentOf(line) !== indent) continue;
    if (line.trim() === `${key}:` || line.trimStart().startsWith(`${key}: `)) return i;
  }
  return -1;
}

// End of the block owned by the key at `lines[start]`: the first later line
// that is neither blank nor indented deeper than that key.
function blockEnd(lines, start, to) {
  const base = indentOf(lines[start]);
  for (let i = start + 1; i < to; i++) {
    if (isBlank(lines[i])) continue;
    if (indentOf(lines[i]) <= base) return i;
  }
  return to;
}

const varLines = (indent) =>
  Object.entries(VARS).map(([k, v]) => `${" ".repeat(indent)}${k}: ${v}`);

const path = process.argv[2];
if (!path) {
  console.error("usage: node patch-built-template.mjs <path-to-built-template.yaml>");
  process.exit(1);
}

const original = readFileSync(path, "utf8");
if (original.includes(MARKER)) {
  console.log(`already patched: ${path}`);
  process.exit(0);
}

const lines = original.split("\n");
const N = lines.length;
const marker = (indent) => `${" ".repeat(indent)}# ${MARKER}`;

const globals = findKey(lines, "Globals", 0, 0, N);

if (globals === -1) {
  // No Globals section. Add a complete one immediately before Resources.
  const resources = findKey(lines, "Resources", 0, 0, N);
  if (resources === -1) {
    console.error(`could not find Globals or Resources in ${path}`);
    process.exit(1);
  }
  lines.splice(resources, 0,
    "Globals:", "  Function:", "    Environment:", "      Variables:",
    marker(8), ...varLines(8), "");
} else {
  const gEnd = blockEnd(lines, globals, N);
  // Find `Function:` anywhere inside Globals, not just on the first line of
  // it -- an `Api:` block may come first.
  const fn = findKey(lines, "Function", 2, globals + 1, gEnd);

  if (fn === -1) {
    lines.splice(gEnd, 0,
      "  Function:", "    Environment:", "      Variables:",
      marker(8), ...varLines(8));
  } else {
    const fnEnd = blockEnd(lines, fn, gEnd);
    const env = findKey(lines, "Environment", 4, fn + 1, fnEnd);

    if (env === -1) {
      lines.splice(fnEnd, 0,
        "    Environment:", "      Variables:", marker(8), ...varLines(8));
    } else {
      const envEnd = blockEnd(lines, env, fnEnd);
      const vars = findKey(lines, "Variables", 6, env + 1, envEnd);

      if (vars === -1) {
        lines.splice(envEnd, 0, "      Variables:", marker(8), ...varLines(8));
      } else {
        // Merge into the existing Variables block: replace any key we also
        // set, then append the rest. No duplicate keys, and any variable the
        // template declared that we do not override is left alone.
        let varsEnd = blockEnd(lines, vars, envEnd);
        const existingIndent = (() => {
          for (let i = vars + 1; i < varsEnd; i++) {
            if (!isBlank(lines[i]) && !isComment(lines[i])) return indentOf(lines[i]);
          }
          return 8;
        })();
        const pending = { ...VARS };
        // Collect the keys we override before touching anything, together with
        // the full extent of each one's block. A variable's value may be a
        // nested block rather than a scalar -- `sam build` renders a !Ref that
        // way:
        //
        //     TABLE_NAME:
        //       Ref: WalletTestTable
        //
        // so replacing only the key's own line would leave the child line
        // orphaned under a scalar and produce invalid YAML.
        const replacements = [];
        for (let i = vars + 1; i < varsEnd; i++) {
          if (isBlank(lines[i]) || isComment(lines[i])) continue;
          if (indentOf(lines[i]) !== existingIndent) continue;
          const name = lines[i].trim().split(":")[0];
          if (name in pending) {
            replacements.push({ start: i, end: blockEnd(lines, i, varsEnd), name });
            delete pending[name];
          }
        }
        // Apply back to front so earlier indices stay valid.
        let removed = 0;
        for (let r = replacements.length - 1; r >= 0; r--) {
          const { start, end, name } = replacements[r];
          lines.splice(start, end - start, `${" ".repeat(existingIndent)}${name}: ${VARS[name]}`);
          removed += end - start - 1;
        }
        varsEnd -= removed;
        const add = Object.entries(pending).map(
          ([k, v]) => `${" ".repeat(existingIndent)}${k}: ${v}`
        );
        lines.splice(varsEnd, 0, marker(existingIndent), ...add);
      }
    }
  }
}

writeFileSync(path, lines.join("\n"));
console.log(`patched: ${path}`);
