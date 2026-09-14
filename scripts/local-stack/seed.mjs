// Seeds the local stack's AWS substitutes (DynamoDB Local + MinIO) with the
// demo account and space the front end and the e2e tests expect.
//
// Idempotent: re-running overwrites the same table item and object keys.
// See AGENTS.md ("Local stack") for how this fits the three-repo setup.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  DynamoDBClient,
  CreateTableCommand,
  PutItemCommand,
  DescribeTableCommand,
} from "@aws-sdk/client-dynamodb";
import {
  S3Client,
  CreateBucketCommand,
  PutObjectCommand,
  HeadBucketCommand,
} from "@aws-sdk/client-s3";
import { Ed25519VerificationKey } from "@interop/ed25519-verification-key";
import { Ed25519Signature2020 } from "@interop/ed25519-signature";
import * as didKey from "@interop/did-method-key";
import jsigs from "@interop/jsonld-signatures";

const DYNAMO_ENDPOINT = process.env.LOCAL_DYNAMODB_URL ?? "http://localhost:8000";
const S3_ENDPOINT = process.env.LOCAL_S3_URL ?? "http://localhost:9000";
const REGION = "us-east-1";

// The account the front end's e2e tests log in as. The DID is not stored: it
// is derived from the passphrase, so the table always agrees with whatever the
// login page derives.
const TABLE_NAME = "wallet-test";
const DEMO_EMAIL = "jc.chartrand@gmail.com";
const DEMO_PASSPHRASE = "my-secret-seed-that-is-long-enou";

// The space id the e2e tests hard-code. One S3 bucket per space, named for the
// space id, so the bucket name is the space id verbatim.
const SPACE_ID = "dcc-was-01011f5b-59ea-4e62-880e-d6ad666e361c";
const COLLECTION_ID = "UniversityOfToronto";

// An optional second account, so you can sign in as yourself instead of the
// demo user:
//
//   SEED_EMAIL=you@example.org SEED_PASSPHRASE='your passphrase' npm run seed
//
// It gets its own space rather than sharing the demo one: the authorizer finds
// an account by scanning for an exact spaceURL match and takes the first hit,
// so two accounts on one space would resolve to whichever row came back first
// and verify against the wrong DID.
const SEED_EMAIL = process.env.SEED_EMAIL;
const SEED_PASSPHRASE = process.env.SEED_PASSPHRASE;
// Deliberately not defaulted to DEMO_PASSPHRASE. That passphrase is committed
// in this repo, so falling back to it would hand your account a key anyone can
// derive -- and you would not be able to log in with the passphrase you meant.
if (SEED_EMAIL && !SEED_PASSPHRASE) {
  console.error("SEED_EMAIL is set but SEED_PASSPHRASE is not. Set both:");
  console.error("  SEED_EMAIL=you@example.org SEED_PASSPHRASE='your passphrase' npm run seed");
  process.exit(1);
}

// Derived so the same email always gets the same space, and valid as an S3
// bucket name (the email itself is not).
const spaceIdForEmail = (email) =>
  `dcc-was-local-${createHash("sha256").update(email).digest("hex").slice(0, 12)}`;

// The authorizer matches the request's space URL against this value exactly,
// so it must be the local was-server-aws origin, not the deployed one.
const spaceUrlFor = (spaceId) => `http://localhost:3000/space/${spaceId}`;

const credentials = { accessKeyId: "localtest", secretAccessKey: "localtest" };
const ddb = new DynamoDBClient({ region: REGION, endpoint: DYNAMO_ENDPOINT, credentials });
// MinIO is addressed by hostname, so per-bucket subdomains do not resolve.
const s3 = new S3Client({
  region: REGION,
  endpoint: S3_ENDPOINT,
  credentials,
  forcePathStyle: true,
});

// Same derivation as the front end's deriveKeyPair(): SHA-256(passphrase) is
// the Ed25519 seed, so one passphrase always yields one did:key.
async function deriveKeyPair(passphrase) {
  const seed = new Uint8Array(createHash("sha256").update(passphrase).digest());
  const keyPair = await Ed25519VerificationKey.generate({ seed });
  keyPair.controller = `did:key:${keyPair.fingerprint()}`;
  keyPair.id = `${keyPair.controller}#${keyPair.fingerprint()}`;
  return keyPair;
}

// The driver needs its key types registered, or get() throws
// `Unsupported "multibaseMultikeyHeader"`. The did:key branch of
// documentLoader is not reached by signing today, but verification would.
const didKeyDriver = didKey.driver();
didKeyDriver.use({
  multibaseMultikeyHeader: "z6Mk",
  fromMultibase: Ed25519VerificationKey.from,
});
// Resolves did:key locally and fetches the remote JSON-LD contexts the
// credential references. Contexts are cached per run.
const contextCache = new Map();
async function documentLoader(url) {
  if (url.startsWith("did:key:")) {
    const did = url.split("#")[0];
    const didDocument = await didKeyDriver.get({ did });
    return { contextUrl: null, documentUrl: did, document: didDocument };
  }
  if (!contextCache.has(url)) {
    const res = await fetch(url, { headers: { accept: "application/ld+json, application/json" } });
    if (!res.ok) throw new Error(`context fetch failed: ${url} -> ${res.status}`);
    contextCache.set(url, await res.json());
  }
  return { contextUrl: null, documentUrl: url, document: contextCache.get(url) };
}

// The second credential the e2e tests verify. No signed fixture for it exists
// in the repo, so it is signed here with a deterministic throwaway issuer key
// (a fixed seed, so the issuer DID is stable across runs). It is not one of the
// front end's trusted issuer DIDs, which is why the tests assert only that its
// signature is valid.
async function signBachelorsCredential() {
  const issuerKey = await deriveKeyPair("lcw-local-stack-demo-issuer");
  const credential = {
    "@context": [
      "https://www.w3.org/ns/credentials/v2",
      "https://purl.imsglobal.org/spec/ob/v3p0/context-3.0.2.json",
      "https://w3id.org/security/suites/ed25519-2020/v1",
    ],
    id: "urn:uuid:9b5c2f14-6a3d-4f8e-9c1b-2d7e4a8f0c36",
    type: ["VerifiableCredential", "OpenBadgeCredential"],
    issuer: {
      id: issuerKey.controller,
      type: ["Profile"],
      name: "University of Toronto",
      url: "https://www.utoronto.ca/",
    },
    validFrom: "2026-01-15T00:00:00Z",
    name: "Bachelors in Computer Science",
    credentialSubject: {
      name: "me",
      type: ["AchievementSubject"],
      achievement: {
        id: "urn:uuid:3f1e8d92-77b4-4c05-9ad6-1e0b5c9a4d21",
        type: ["Achievement"],
        achievementType: "Degree",
        name: "Bachelors in Computer Science",
        description: "A four-year undergraduate degree in Computer Science.",
        criteria: {
          narrative: "Completion of the Honours Bachelor of Science program in Computer Science.",
        },
      },
    },
  };

  const signed = await jsigs.sign(credential, {
    suite: new Ed25519Signature2020({
      signer: issuerKey.signer(),
      verificationMethod: issuerKey.id,
    }),
    purpose: new jsigs.purposes.AssertionProofPurpose(),
    documentLoader,
  });
  console.log(`  signed Bachelors credential (issuer ${issuerKey.controller})`);
  return { "@context": ["https://www.w3.org/ns/credentials/v2"], type: ["VerifiablePresentation"], verifiableCredential: [signed] };
}

async function ensureTable() {
  try {
    await ddb.send(new DescribeTableCommand({ TableName: TABLE_NAME }));
    console.log(`  table ${TABLE_NAME} already exists`);
  } catch (err) {
    if (err.name !== "ResourceNotFoundException") throw err;
    await ddb.send(new CreateTableCommand({
      TableName: TABLE_NAME,
      AttributeDefinitions: [{ AttributeName: "email", AttributeType: "S" }],
      KeySchema: [{ AttributeName: "email", KeyType: "HASH" }],
      BillingMode: "PAY_PER_REQUEST",
    }));
    console.log(`  created table ${TABLE_NAME}`);
  }
}

async function ensureBucket(bucket) {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    console.log(`  bucket ${bucket} already exists`);
    return;
  } catch (err) {
    // Only a genuine 404 means "create it". Anything else -- MinIO not up, bad
    // credentials -- should surface rather than be retried as a create, which
    // would fail with a less useful error.
    const status = err.$metadata?.httpStatusCode;
    if (status !== 404 && err.name !== "NotFound" && err.name !== "NoSuchBucket") throw err;
  }
  await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  console.log(`  created bucket ${bucket}`);
}

const putJson = (bucket, Key, body) =>
  s3.send(new PutObjectCommand({
    Bucket: bucket,
    Key,
    Body: JSON.stringify(body, null, 2),
    ContentType: "application/json",
  }));

// Registers one account and gives it a space holding the two demo credentials.
async function seedAccount({ email, passphrase, spaceId }) {
  const spaceUrl = spaceUrlFor(spaceId);
  const key = await deriveKeyPair(passphrase);
  console.log(`\n  ${email} -> ${key.controller}`);

  await ddb.send(new PutItemCommand({
    TableName: TABLE_NAME,
    Item: {
      email: { S: email },
      did: { S: key.controller },
      spaceURL: { S: spaceUrl },
      CreatedAt: { S: new Date().toISOString() },
    },
  }));
  console.log(`  registered with spaceURL ${spaceUrl}`);

  await ensureBucket(spaceId);

  // The space description supplies the name the collections page shows.
  await putJson(spaceId, "metadata/description.json", {
    id: spaceId,
    type: ["Space"],
    name: "Verifiable Credentials Collection",
    controller: key.controller,
    createdBy: key.controller,
  });
  await putJson(spaceId, `collections/${COLLECTION_ID}/description.json`, {
    id: COLLECTION_ID,
    type: ["Collection"],
    name: COLLECTION_ID,
  });

  // LCWExperience is the repo's own signed fixture, whose issuer is one of the
  // front end's trusted issuer DIDs, so it verifies as a known issuer.
  const fixture = JSON.parse(
    readFileSync(new URL("../../tests/fixtures/PlaywrightUpload.json", import.meta.url), "utf8")
  );
  await putJson(spaceId, `collections/${COLLECTION_ID}/LCWExperience.json`, fixture);
  await putJson(spaceId, `collections/${COLLECTION_ID}/Bachelors.json`, await signBachelorsCredential());
  console.log(`  wrote the descriptions, LCWExperience.json and Bachelors.json`);
}

console.log("Seeding the LCW local stack");
await ensureTable();

// The demo account is always seeded: the e2e tests hard-code its email and
// space id.
await seedAccount({ email: DEMO_EMAIL, passphrase: DEMO_PASSPHRASE, spaceId: SPACE_ID });

if (SEED_EMAIL) {
  await seedAccount({
    email: SEED_EMAIL,
    passphrase: SEED_PASSPHRASE,
    spaceId: spaceIdForEmail(SEED_EMAIL),
  });
}

console.log("\nDone. Restart nothing; the APIs read this on the next request.");
