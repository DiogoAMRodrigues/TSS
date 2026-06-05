/**
 * Real eIDAS provider — Autenticação.gov (AMA) preprod / prod integration.
 *
 * SAML 2.0 SP using HTTP-POST binding + Web Browser SSO Profile.
 * Supports AMA's custom <fa:RequestedAttributes> extension under the
 * namespace http://autenticacao.cartaodecidadao.pt/atributos.
 *
 * Drop-in replacement for SimulatedEidasProvider — same verifyIdentity()
 * interface — but the heavy lifting (AuthnRequest building, Response
 * validation, attribute extraction) happens in the eIDAS route (see
 * routes/eidasRoutes.js). verifyIdentity() here just runs the sanctions
 * check and returns the approval object the rest of the pipeline expects.
 *
 * Env vars (see middleware/.env.example):
 *   EIDAS_IDP_ENTRY_POINT       e.g. https://preprod.autenticacao.gov.pt/fa/Default.aspx
 *   EIDAS_IDP_CERT_PATH         AMA preprod IdP signing cert (PEM)
 *   EIDAS_IDP_ISSUER            (optional) pin IdP Issuer for response check
 *   EIDAS_SP_ENTITY_ID          https://tss.dpss.inesc-id.pt
 *   EIDAS_SP_PROVIDER_NAME      "TSS - Instituto Superior Técnico"
 *   EIDAS_SP_ACS_URL            https://tss.dpss.inesc-id.pt/api/kyc/eidas/callback
 *   EIDAS_SP_CERT_PATH          our SP cert AMA signed (PEM)
 *   EIDAS_SP_KEY_PATH           our SP private key (PEM)
 *   EIDAS_REQUESTED_ATTRIBUTES  comma-separated AMA attribute SHORT names
 *                               (NIC,NomeCompleto,NomeProprio,NomeApelido,
 *                                DataNascimento,CorreioElectronico)
 *   EIDAS_CLOCK_SKEW_SECONDS    (optional, default 60) tolerance for NotBefore/NotOnOrAfter
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { SignedXml } = require("xml-crypto");
const { DOMParser } = require("@xmldom/xmldom");
const xpath = require("xpath");

// ---- AMA constants ---------------------------------------------------------

const FA_NS = "http://autenticacao.cartaodecidadao.pt/atributos";
const ATTR_BASE = "http://interop.gov.pt/MDC/Cidadao/";
const ATTR_FORMAT = "urn:oasis:names:tc:SAML:2.0:attrname-format:uri";
const SAMLP_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const DS_NS = "http://www.w3.org/2000/09/xmldsig#";

// Map short name → full URN. Add more as AMA approves them.
const ATTR_URN = {
  NIC: ATTR_BASE + "NIC",
  NICCifrado: ATTR_BASE + "NICCifrado",
  NomeCompleto: ATTR_BASE + "NomeCompleto",
  NomeProprio: ATTR_BASE + "NomeProprio",
  NomeApelido: ATTR_BASE + "NomeApelido",
  DataNascimento: ATTR_BASE + "DataNascimento",
  CorreioElectronico: ATTR_BASE + "CorreioElectronico",
  NIF: ATTR_BASE + "NIF",
  Nacionalidade: ATTR_BASE + "Nacionalidade",
  Sexo: ATTR_BASE + "Sexo",
};

// ---- Helpers ---------------------------------------------------------------

function readPemCert(absPath) {
  const raw = fs.readFileSync(absPath, "utf8");
  // Extract ONLY the first BEGIN/END CERTIFICATE block; ignore any trailing
  // openssl human-readable metadata (subject=, issuer=, etc.) that AMA may
  // have appended to the file.
  const m = raw.match(/-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/);
  if (!m) {
    throw new Error(`No PEM CERTIFICATE block found in ${absPath}`);
  }
  return m[1].replace(/\s+/g, "");
}

function genId() {
  // SAML IDs must start with a non-numeric. Use _ + 32 hex chars.
  return "_" + crypto.randomBytes(16).toString("hex");
}

function nowIso() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function resolveFromCwd(rel) {
  if (!rel) return null;
  if (path.isAbsolute(rel)) return rel;
  return path.resolve(process.cwd(), rel);
}

// ---- Provider --------------------------------------------------------------

class RealEidasProvider {
  constructor(options = {}) {
    this.name = "real-eidas-ama";
    const cfg = {
      idpEntryPoint: options.idpEntryPoint || process.env.EIDAS_IDP_ENTRY_POINT,
      idpCertPath: options.idpCertPath || process.env.EIDAS_IDP_CERT_PATH,
      idpIssuer: options.idpIssuer || process.env.EIDAS_IDP_ISSUER || null,
      spEntityId: options.spEntityId || process.env.EIDAS_SP_ENTITY_ID,
      spProviderName: options.spProviderName || process.env.EIDAS_SP_PROVIDER_NAME,
      spAcsUrl: options.spAcsUrl || process.env.EIDAS_SP_ACS_URL,
      spCertPath: options.spCertPath || process.env.EIDAS_SP_CERT_PATH,
      spKeyPath: options.spKeyPath || process.env.EIDAS_SP_KEY_PATH,
      requestedAttributes: (options.requestedAttributes ||
        process.env.EIDAS_REQUESTED_ATTRIBUTES ||
        "NIC,NomeCompleto,DataNascimento,CorreioElectronico"
      )
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      // AMA-specific: Federation Authentication Assurance Level.
      // 1 = low, 2 = substantial, 3 = high (CC+PIN or CMD with strong auth).
      // Required by AMA inside <samlp:Extensions> for the AuthnRequest to be
      // accepted. Default 3 per AMA integration guidance.
      faaaLevel: String(
        options.faaaLevel || process.env.EIDAS_FAAA_LEVEL || "3"
      ),
      // AMA's example uses isRequired="False" (capital F). Keep configurable
      // so we can flip per-attribute behavior later if needed.
      requestedAttrRequired: String(
        options.requestedAttrRequired ||
          process.env.EIDAS_REQUESTED_ATTR_REQUIRED ||
          "False"
      ),
      clockSkewSeconds: Number(
        options.clockSkewSeconds || process.env.EIDAS_CLOCK_SKEW_SECONDS || 60
      ),
    };

    const required = [
      "idpEntryPoint",
      "idpCertPath",
      "spEntityId",
      "spProviderName",
      "spAcsUrl",
      "spCertPath",
      "spKeyPath",
    ];
    const missing = required.filter((k) => !cfg[k]);
    if (missing.length) {
      throw new Error(
        `RealEidasProvider: missing required config: ${missing.join(", ")}`
      );
    }

    // Resolve cert/key paths relative to cwd (matches dotenv path convention)
    const idpCertAbs = resolveFromCwd(cfg.idpCertPath);
    const spCertAbs = resolveFromCwd(cfg.spCertPath);
    const spKeyAbs = resolveFromCwd(cfg.spKeyPath);

    cfg._idpCertB64 = readPemCert(idpCertAbs);
    cfg._spCertB64 = readPemCert(spCertAbs);
    cfg._spKeyPem = fs.readFileSync(spKeyAbs, "utf8");

    // Validate unknown attribute names early so misconfig fails fast.
    const unknown = cfg.requestedAttributes.filter((n) => !ATTR_URN[n]);
    if (unknown.length) {
      throw new Error(
        `RealEidasProvider: unknown attribute name(s): ${unknown.join(", ")}. ` +
          `Add them to ATTR_URN map in realEidasProvider.js or fix env.`
      );
    }

    this.config = cfg;
  }

  // -------- AuthnRequest ---------------------------------------------------

  /**
   * Build a signed SAML 2.0 AuthnRequest XML string with AMA's
   * <samlp:Extensions><fa:RequestedAttributes/></samlp:Extensions>.
   * Returns { id, xml, base64 }.
   * The caller renders the standard HTTP-POST auto-submit form.
   */
  buildAuthnRequest({ relayState } = {}) {
    const id = genId();
    const issueInstant = nowIso();

    const isRequired = this.config.requestedAttrRequired;
    const attrs = this.config.requestedAttributes
      .map(
        (name) =>
          `<fa:RequestedAttribute Name="${ATTR_URN[name]}" NameFormat="${ATTR_FORMAT}" isRequired="${isRequired}" />`
      )
      .join("");
    // AMA-mandated structure (per Autenticação.gov integration guidance):
    //   <samlp:Extensions>
    //     <fa:FAAALevel xmlns:fa="...">3</fa:FAAALevel>
    //     <fa:RequestedAttributes xmlns:fa="...">
    //       <fa:RequestedAttribute .../>
    //     </fa:RequestedAttributes>
    //   </samlp:Extensions>
    // FAAALevel must come BEFORE RequestedAttributes. Both elements declare
    // the fa: namespace on themselves (matches AMA's reference example).
    const extensions =
      `<samlp:Extensions>` +
      `<fa:FAAALevel xmlns:fa="${FA_NS}">${this.config.faaaLevel}</fa:FAAALevel>` +
      `<fa:RequestedAttributes xmlns:fa="${FA_NS}">${attrs}</fa:RequestedAttributes>` +
      `</samlp:Extensions>`;

    // Order of children matters in SAML: Issuer → Signature (after sign) → Extensions → NameIDPolicy → ...
    // We build without <Signature/>, then xml-crypto inserts it between Issuer and Extensions
    // by way of the "prefix" + "location" we configure below.
    const xml =
      `<samlp:AuthnRequest xmlns:samlp="${SAMLP_NS}" xmlns:saml="${SAML_NS}" ` +
      `ID="${id}" Version="2.0" IssueInstant="${issueInstant}" ` +
      `Destination="${this.config.idpEntryPoint}" ` +
      `ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST" ` +
      `AssertionConsumerServiceURL="${this.config.spAcsUrl}" ` +
      `ProviderName="${this._xmlEscape(this.config.spProviderName)}">` +
      `<saml:Issuer>${this.config.spEntityId}</saml:Issuer>` +
      extensions +
      `<samlp:NameIDPolicy Format="urn:oasis:names:tc:SAML:1.1:nameid-format:unspecified" AllowCreate="true" />` +
      `</samlp:AuthnRequest>`;

    const signedXml = this._signRequest(xml, id);
    const base64 = Buffer.from(signedXml, "utf8").toString("base64");
    return { id, xml: signedXml, base64, relayState };
  }

  _signRequest(xml, refId) {
    const certB64 = this.config._spCertB64;
    const sig = new SignedXml({
      privateKey: this.config._spKeyPem,
      signatureAlgorithm: "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256",
      canonicalizationAlgorithm: "http://www.w3.org/2001/10/xml-exc-c14n#",
      // xml-crypto v6: must pass via constructor (post-hoc assignment is lost).
      // Emit KeyInfo with our SP cert so AMA can identify which cert signed.
      getKeyInfoContent: ({ prefix } = {}) => {
        const p = prefix ? `${prefix}:` : "";
        return `<${p}X509Data><${p}X509Certificate>${certB64}</${p}X509Certificate></${p}X509Data>`;
      },
    });
    sig.addReference({
      xpath: `//*[local-name(.)='AuthnRequest']`,
      transforms: [
        "http://www.w3.org/2000/09/xmldsig#enveloped-signature",
        "http://www.w3.org/2001/10/xml-exc-c14n#",
      ],
      digestAlgorithm: "http://www.w3.org/2001/04/xmlenc#sha256",
      uri: `#${refId}`,
    });
    sig.computeSignature(xml, {
      prefix: "ds",
      location: { reference: `//*[local-name(.)='Issuer']`, action: "after" },
    });
    return sig.getSignedXml();
  }

  // -------- Response validation -------------------------------------------

  /**
   * Validate the IdP signature on a base64-encoded SAMLResponse and return
   * the parsed assertion + extracted attributes.
   * Throws on any validation failure.
   */
  validateResponse(samlResponseB64) {
    const xmlStr = Buffer.from(samlResponseB64, "base64").toString("utf8");
    const doc = new DOMParser().parseFromString(xmlStr, "text/xml");
    const select = xpath.useNamespaces({
      samlp: SAMLP_NS,
      saml: SAML_NS,
      ds: DS_NS,
      fa: FA_NS,
    });

    // 1. Signature on the Response element
    const sigNode = select("/samlp:Response/ds:Signature", doc)[0];
    if (!sigNode) {
      throw new Error("SAMLResponse missing top-level <ds:Signature>");
    }
    const { SignedXml: VerifyXml } = require("xml-crypto");
    const verifier = new VerifyXml({
      publicCert: this._idpCertPem(),
    });
    verifier.loadSignature(sigNode);
    const ok = verifier.checkSignature(xmlStr);
    if (!ok) {
      throw new Error(
        "SAMLResponse signature invalid: " +
          (verifier.getSignedReferences ? "ref mismatch" : "bad signature")
      );
    }

    // 2. Status code
    const status = select(
      "string(/samlp:Response/samlp:Status/samlp:StatusCode/@Value)",
      doc
    );
    if (status !== "urn:oasis:names:tc:SAML:2.0:status:Success") {
      const sub = select(
        "string(/samlp:Response/samlp:Status/samlp:StatusCode/samlp:StatusCode/@Value)",
        doc
      );
      throw new Error(`SAMLResponse status not Success: ${status} (${sub})`);
    }

    // 3. Issuer (optional pin)
    const issuer = select("string(/samlp:Response/saml:Issuer)", doc);
    if (this.config.idpIssuer && issuer !== this.config.idpIssuer) {
      throw new Error(
        `Unexpected IdP Issuer: got "${issuer}", expected "${this.config.idpIssuer}"`
      );
    }

    // 4. Assertion + Conditions
    const assertion = select("/samlp:Response/saml:Assertion", doc)[0];
    if (!assertion) throw new Error("SAMLResponse missing <saml:Assertion>");

    const audience = select(
      "string(.//saml:Conditions/saml:AudienceRestriction/saml:Audience)",
      assertion
    );
    if (audience && audience !== this.config.spEntityId) {
      throw new Error(
        `Audience mismatch: got "${audience}", expected "${this.config.spEntityId}"`
      );
    }

    const notBefore = select("string(./saml:Conditions/@NotBefore)", assertion);
    const notOnOrAfter = select(
      "string(./saml:Conditions/@NotOnOrAfter)",
      assertion
    );
    const skewMs = this.config.clockSkewSeconds * 1000;
    const now = Date.now();
    if (notBefore && now + skewMs < new Date(notBefore).getTime()) {
      throw new Error(`Assertion not yet valid (NotBefore=${notBefore})`);
    }
    if (notOnOrAfter && now - skewMs >= new Date(notOnOrAfter).getTime()) {
      throw new Error(`Assertion expired (NotOnOrAfter=${notOnOrAfter})`);
    }

    // 5. Extract attributes
    const attrNodes = select(
      ".//saml:AttributeStatement/saml:Attribute",
      assertion
    );
    const attributes = {};
    for (const node of attrNodes) {
      const name = select("string(@Name)", node);
      const status = select(
        `string(@*[local-name()='AttributeStatus'])`,
        node
      );
      const value = select("string(./saml:AttributeValue)", node);
      attributes[name] = { value: value || null, status: status || "Available" };
    }

    const assertionId = select("string(./@ID)", assertion);
    return { assertionId, issuer, attributes, audience, notBefore, notOnOrAfter };
  }

  _idpCertPem() {
    // xml-crypto wants PEM with armor for verification
    const b64 = this.config._idpCertB64;
    return (
      "-----BEGIN CERTIFICATE-----\n" +
      b64.match(/.{1,64}/g).join("\n") +
      "\n-----END CERTIFICATE-----\n"
    );
  }

  _xmlEscape(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&apos;");
  }

  /** Pull the AMA short-name attributes out of the validated bag. */
  extractIdentity(validated) {
    const a = validated.attributes || {};
    const get = (shortName) => a[ATTR_URN[shortName]]?.value || null;
    return {
      nic: get("NIC"),
      nicCifrado: get("NICCifrado"),
      nomeCompleto: get("NomeCompleto"),
      nomeProprio: get("NomeProprio"),
      nomeApelido: get("NomeApelido"),
      dataNascimento: get("DataNascimento"),
      email: get("CorreioElectronico"),
      nif: get("NIF"),
      _raw: a,
    };
  }

  // -------- Same interface as SimulatedEidasProvider ----------------------

  async verifyIdentity({ walletAddress, requestedRole, identityData }) {
    const normalizedRole = String(requestedRole || "TRADER").toUpperCase();

    if (!identityData?.samlAttributes) {
      return {
        approved: false,
        reason:
          "Missing SAML attributes — must complete /api/kyc/eidas/start → AMA → /api/kyc/eidas/callback first",
      };
    }

    if (!identityData.samlAttributes.nic) {
      return {
        approved: false,
        reason: "AMA assertion did not include NIC attribute",
      };
    }

    if (identityData.isSanctioned || identityData.isPep) {
      return { approved: false, reason: "Sanctions or PEP check failed" };
    }

    return {
      approved: true,
      role: normalizedRole,
      evidenceId: `AMA-${identityData.assertionId || Date.now()}`,
      provider: this.name,
      attributes: identityData.samlAttributes,
    };
  }
}

module.exports = RealEidasProvider;
