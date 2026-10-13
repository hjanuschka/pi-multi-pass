# Experimental `/subs share` protocol v1

This protocol copies OAuth credentials. A compatible receiver must be trusted with the provider account; this is not a quota-only pairing mechanism. No server persists after the one-shot transfer. Provider-specific support for simultaneous refresh on two devices is **not yet validated**.

## Discovery and handoff

The sender listens on a selected private IPv4 interface (LAN or tailnet) for at most 120 seconds. Its QR is a URI of the form `mps-share://v1/<base64url(JSON)>`, where JSON contains:

```json
{ "a": "192.168.1.2", "p": 12345, "f": "SHA256_CERT_FINGERPRINT_HEX", "s": "32_RANDOM_BYTES_BASE64URL" }
```

The URI is a secret until the session expires. It contains no OAuth tokens. The receiver validates the IP is private, pins the TLS peer's DER certificate SHA-256 fingerprint to `f` **before sending any request bytes**, and posts to `https://<a>:<p>/v1/share`:

```json
{ "secret": "s", "name": "Receiver device name", "publicKey": "X25519_SPKI_DER_BASE64URL" }
```

The receiver shows the first eight uppercase hexadecimal digits of `SHA256(UTF8("pi-multi-pass-share-v1:" + s + ":" + publicKey))`. The sender shows the receiver name and the same code and must approve explicitly. Only the first valid request can be approved; denial, expiry, cancel or delivery closes the listener. TLS is self-signed and ephemeral. Do not use a general-purpose `insecure` HTTPS mode without the pin comparison.

## Encrypted response

After approval the response is JSON `{ "key", "salt", "nonce", "data", "tag" }`, where `key` is a fresh sender X25519 public key in SPKI DER base64url, `salt` is 32 random bytes, and `nonce` is 12 random bytes. Derive `shared = X25519(senderPrivate, receiverPublic)` and `aesKey = HKDF-SHA256(shared, salt, UTF8("pi-multi-pass-share-v1"), 32)`. `data` is AES-256-GCM encryption of UTF-8 JSON; `tag` is its authentication tag. Fields other than `key` are base64url-encoded. Never log, cache, upload or expose the plaintext bundle to unrelated processes. Sender limits request size; receivers must also limit response size. A non-200 response means denied, expired, or already consumed.

The plaintext is `{ "schemaVersion": 1, "accounts": [...] }`. Each account has `providerName`, `baseProvider`, optional `label`, and `credential` with `type: "oauth"`, `access`, `refresh`, `expires` (Unix **milliseconds**), and optional `accountId`, `projectId`, `enterpriseUrl` (provider-specific). Other credentials and config are not included. A receiver must validate the bundle and explicitly choose secure local storage. Native mobile receivers should use Keychain or Keystore-backed storage, not pi's `auth.json` format. Do not assume a token copied from desktop can be refreshed on mobile until verified with that provider.

## Constraints

V1 only supports private IPv4 addresses and one account per invocation. It has no cloud relay, internet endpoint, automatic sync, remote revocation or guarantee that two clients can refresh the same provider credential independently. A compromised receiver can use the imported account until its credential is revoked at the provider. For a desktop pi receiver, `/subs receive` imports under a fresh indexed provider name and requires a pi restart to register it.
