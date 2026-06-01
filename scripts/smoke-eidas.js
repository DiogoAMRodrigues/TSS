/**
 * Local smoke test for the real eIDAS (AMA) provider.
 *
 * Loads .env, instantiates RealEidasProvider, builds a signed AuthnRequest,
 * decodes it, prints the XML, and runs structural assertions.
 *
 * Usage:
 *   # Make sure .env in repo root has all EIDAS_* vars set and certs/keys
 *   # are present at the configured paths.
 *   node scripts/smoke-eidas.js
 *
 * Exits non-zero on any structural failure.
 */

"use strict";

require("dotenv").config();
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { DOMParser } = require("@xmldom/xmldom");
const xpath = require("xpath");

const RealEidasProvider =
  require("../middleware/src/providers/realEidasProvider.js");

function fail(msg) {
  console.error(`\n[FAIL] ${msg}`);
  process.exit(1);
}
function ok(msg) {
  console.log(`[ OK ] ${msg}`);
}

console.log("=== eIDAS smoke test ===\n");
console.log("cwd:", process.cwd());
console.log("EIDAS_PROVIDER:", process.env.EIDAS_PROVIDER || "(unset)");
console.log("EIDAS_IDP_ENTRY_POINT:", process.env.EIDAS_IDP_ENTRY_POINT);
console.log("EIDAS_SP_ENTITY_ID:", process.env.EIDAS_SP_ENTITY_ID);
console.log("EIDAS_SP_ACS_URL:", process.env.EIDAS_SP_ACS_URL);
console.log("EIDAS_REQUESTED_ATTRIBUTES:", process.env.EIDAS_REQUESTED_ATTRIBUTES);
console.log("");

let provider;
try {
  provider = new RealEidasProvider();
  ok("RealEidasProvider instantiated (certs + key loaded)");
} catch (err) {
  fail(`provider construction: ${err.message}`);
}

const walletAddress = "0xDeadBeef0000000000000000000000000000BEEF";
let result;
try {
  result = provider.buildAuthnRequest({ relayState: walletAddress });
  ok("buildAuthnRequest() returned");
} catch (err) {
  fail(`buildAuthnRequest threw: ${err.message}`);
}

if (!result || !result.id || !result.xml || !result.base64) {
  fail("result missing id/xml/base64");
}
ok(`AuthnRequest ID: ${result.id}`);

// --- decode + parse ---------------------------------------------------------
let decoded;
try {
  decoded = Buffer.from(result.base64, "base64").toString("utf8");
} catch (err) {
  fail(`base64 decode: ${err.message}`);
}
if (decoded !== result.xml) {
  fail("base64 round-trip does not equal raw XML (encoding mismatch)");
}
ok("base64 round-trip clean");

const doc = new DOMParser().parseFromString(decoded, "text/xml");
if (!doc || !doc.documentElement) fail("DOMParser returned no document");
ok("XML parses");

// --- save the artifact for human inspection --------------------------------
const outDir = path.resolve(process.cwd(), "scripts", "smoke-out");
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, "authn-request.xml");
fs.writeFileSync(outFile, decoded, "utf8");
ok(`AuthnRequest XML saved -> ${outFile}`);

// --- structural assertions --------------------------------------------------
const select = xpath.useNamespaces({
  samlp: "urn:oasis:names:tc:SAML:2.0:protocol",
  saml: "urn:oasis:names:tc:SAML:2.0:assertion",
  ds: "http://www.w3.org/2000/09/xmldsig#",
  fa: "http://autenticacao.cartaodecidadao.pt/atributos",
});

const root = doc.documentElement;
if (root.localName !== "AuthnRequest")
  fail(`root element is <${root.localName}>, expected <AuthnRequest>`);
ok("root is samlp:AuthnRequest");

const dest = root.getAttribute("Destination");
if (dest !== process.env.EIDAS_IDP_ENTRY_POINT)
  fail(`Destination=${dest} != EIDAS_IDP_ENTRY_POINT`);
ok(`Destination matches IdP entry point`);

const acs = root.getAttribute("AssertionConsumerServiceURL");
if (acs !== process.env.EIDAS_SP_ACS_URL)
  fail(`AssertionConsumerServiceURL=${acs} != EIDAS_SP_ACS_URL`);
ok("AssertionConsumerServiceURL matches");

const providerName = root.getAttribute("ProviderName");
if (providerName !== process.env.EIDAS_SP_PROVIDER_NAME)
  fail(`ProviderName=${providerName} != EIDAS_SP_PROVIDER_NAME`);
ok("ProviderName matches");

const issuer = select("string(saml:Issuer)", root);
if (issuer !== process.env.EIDAS_SP_ENTITY_ID)
  fail(`Issuer=${issuer} != EIDAS_SP_ENTITY_ID`);
ok("Issuer matches SP EntityID");

const sigNodes = select("ds:Signature", root);
if (!sigNodes.length) fail("no <ds:Signature> in AuthnRequest");
ok("Signature element present");

const sigMethod = select(
  "string(ds:Signature/ds:SignedInfo/ds:SignatureMethod/@Algorithm)",
  root
);
if (!/rsa-sha256/i.test(sigMethod))
  fail(`SignatureMethod=${sigMethod}, expected rsa-sha256`);
ok(`SignatureMethod = ${sigMethod}`);

const x509Count = select(
  "count(ds:Signature/ds:KeyInfo/ds:X509Data/ds:X509Certificate)",
  root
);
if (Number(x509Count) < 1)
  fail("KeyInfo/X509Data/X509Certificate missing (AMA needs SP cert in sig)");
ok("SP cert embedded in KeyInfo");

const extReqAttrs = select(
  "samlp:Extensions/fa:RequestedAttributes/fa:RequestedAttribute",
  root
);
const expectedAttrs = (process.env.EIDAS_REQUESTED_ATTRIBUTES || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
if (extReqAttrs.length !== expectedAttrs.length) {
  fail(
    `fa:RequestedAttribute count=${extReqAttrs.length}, expected ${expectedAttrs.length}`
  );
}
ok(`fa:RequestedAttributes contains ${extReqAttrs.length} entries`);
for (const node of extReqAttrs) {
  const name = node.getAttribute("Name");
  const fmt = node.getAttribute("NameFormat");
  const req = node.getAttribute("isRequired");
  if (!name.startsWith("http://interop.gov.pt/MDC/Cidadao/"))
    fail(`attribute Name=${name} not in interop.gov.pt URN namespace`);
  if (fmt !== "urn:oasis:names:tc:SAML:2.0:attrname-format:uri")
    fail(`attribute NameFormat=${fmt} unexpected`);
  if (req !== "true") fail(`attribute isRequired=${req}, expected true`);
}
ok("all RequestedAttribute entries well-formed");

// --- signature verification (self-check with our own SP cert) --------------
try {
  const { SignedXml } = require("xml-crypto");
  const verifier = new SignedXml();
  // Use the SP cert to verify (we just signed with the matching key).
  const spCertPath = path.resolve(
    process.cwd(),
    process.env.EIDAS_SP_CERT_PATH
  );
  verifier.publicCert = fs.readFileSync(spCertPath, "utf8");
  const sigXml = sigNodes[0].toString();
  verifier.loadSignature(sigXml);
  const valid = verifier.checkSignature(decoded);
  if (!valid) fail(`xml-crypto signature check failed: ${verifier.getSignedReferences ? "" : ""}`);
  ok("self-signature verifies against SP cert");
} catch (err) {
  fail(`signature self-verify error: ${err.message}`);
}

// --- summary ---------------------------------------------------------------
console.log("\n=== ALL CHECKS PASSED ===");
console.log(`Inspect XML at: ${outFile}`);
console.log(`AuthnRequest ID: ${result.id}`);
console.log(`base64 length: ${result.base64.length} chars`);
