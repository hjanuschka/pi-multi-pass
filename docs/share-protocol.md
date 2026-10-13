# Experimental offline `/subs share` QR format (v2)

`/subs share` copies a selected OAuth credential **entirely inside the QR frames**, with no network connection, server, pairing handshake or cloud service. The receiver can scan frames in any order; `/subs receive` accepts their URIs one at a time. A native iOS or Android app can decode the same frames and store the credential in its secure local storage.

## Security boundary

**Each complete set of frames is a bearer credential.** Anyone who photographs, records, copies, or receives *all* the frames can reconstruct both the access token and refresh token. The data is compressed and base64url-encoded, **not encrypted**. There is no expiry or revocation for a captured QR; closing the screen only hides the local display. Revoking a leaked credential must happen at the provider. Never log QR URIs, send them to analytics or cloud services, include them in screenshots/backups, or render them in session transcripts. Display the QR only after the user explicitly confirms the account and risk. Transfer only in a private setting to a device you trust. There is no way to make an all-in-one, no-passphrase QR confidential from someone who scans it.

Copied provider refresh tokens may rotate or be tied to one device/client. Sharing is experimental; no provider is guaranteed to keep both copies authenticated after refresh. Do not claim persistent multi-device copy until tested for that provider.

## Frame format

Each URI has the form:

```text
mps-share://v2/<exportId>/<index>/<total>/<sha256>/<chunk>
```

- `exportId`: 8 random bytes as 16 lowercase hexadecimal digits, different for every invocation.
- `index`: 1-based frame number; `total`: number of frames, at most 256.
- `sha256`: lowercase hex SHA-256 of the **compressed** bytes, used to detect damaged/mixed frames, not to authenticate the sender.
- `chunk`: up to 200 characters of the base64url-encoded compressed bundle. The full base64url string is split into consecutive chunks; concatenate them in index order, decode, verify SHA-256, then raw-DEFLATE inflate with a 100,000-byte output limit. Validate JSON and the credential allowlist before import.

Bundle plaintext before compression:

```json
{
  "schemaVersion": 2,
  "accounts": [{
    "providerName": "openai-codex-2",
    "baseProvider": "openai-codex",
    "label": "Work",
    "credential": { "type": "oauth", "access": "<secret>", "refresh": "<secret>", "expires": 1791892800000, "accountId": "<provider-id>" }
  }]
}
```

`expires` is Unix **milliseconds**. Optional provider-specific credential fields are `accountId`, `projectId` and `enterpriseUrl`. V2 exports exactly one account per invocation; it does not include other `auth.json` keys, pools, chains, presets or project config. A desktop receiver imports as a fresh indexed subscription and never overwrites an existing login. Mobile receivers must validate the schema and use Keychain or Keystore-backed storage, never a plaintext settings file. Frames can be re-scanned; this is not a one-time transfer. Receiver UIs should display collected count and reject conflicting or mixed exports. Delete partial frame data on cancel.
