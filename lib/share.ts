import { createHash, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, timingSafeEqual, X509Certificate, createCipheriv, createDecipheriv, createPublicKey } from "node:crypto";
import { createServer, type Server } from "node:https";
import { request } from "node:https";
import { isIP } from "node:net";
import { networkInterfaces } from "node:os";
import selfsigned from "selfsigned";
import qr from "qrcode-terminal";

export type SharedAccount = {
	providerName: string;
	baseProvider: string;
	label?: string;
	credential: { type: "oauth"; access: string; refresh: string; expires: number; [key: string]: unknown };
};
export type ShareBundle = { schemaVersion: 1; accounts: SharedAccount[] };
export type ShareOffer = {
	uri: string;
	qr: string;
	pending: Promise<{ name: string; code: string } | null>;
	completed: Promise<boolean>;
	approve(approved: boolean): void;
	close(): void;
};

const LIFE_MS = 120_000;
const MAX_BODY = 4096;
const LIMIT_ACCOUNTS = 20;

function fixedEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}

function privateIPv4(address: string): boolean {
	if (!isIP(address) || isIP(address) !== 4) return false;
	const [a, b] = address.split(".").map(Number);
	return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || a === 127 || (a === 100 && b >= 64 && b <= 127);
}

export function shareAddresses(): string[] {
	return Object.values(networkInterfaces()).flatMap((entries) => entries || [])
		.filter((entry) => entry.family === "IPv4" && !entry.internal && privateIPv4(entry.address))
		.map((entry) => entry.address);
}

export function validateBundle(bundle: ShareBundle): void {
	if (bundle?.schemaVersion !== 1 || !Array.isArray(bundle.accounts) || bundle.accounts.length < 1 || bundle.accounts.length > LIMIT_ACCOUNTS) throw new Error("Invalid share bundle");
	const seen = new Set<string>();
	for (const a of bundle.accounts) {
		if (!a || typeof a.providerName !== "string" || !/^[a-z0-9-]{1,64}$/.test(a.providerName)
			|| typeof a.baseProvider !== "string" || !/^[a-z0-9-]{1,64}$/.test(a.baseProvider)
			|| (a.label !== undefined && (typeof a.label !== "string" || a.label.length > 128))
			|| seen.has(a.providerName)) throw new Error("Invalid account in share bundle");
		seen.add(a.providerName);
		const c = a.credential;
		if (c?.type !== "oauth" || typeof c.access !== "string" || !c.access || c.access.length > 32768
			|| typeof c.refresh !== "string" || !c.refresh || c.refresh.length > 32768
			|| typeof c.expires !== "number" || !Number.isFinite(c.expires) || c.expires < 0
			|| Object.keys(c).some((key) => !["type", "access", "refresh", "expires", "accountId", "projectId", "enterpriseUrl"].includes(key))
			|| [c.accountId, c.projectId, c.enterpriseUrl].some((value) => value !== undefined && (typeof value !== "string" || value.length > 1024))) throw new Error("Invalid OAuth credential");
	}
}

function codeFor(secret: string, receiverPublicKey: string): string {
	return createHash("sha256").update(`pi-multi-pass-share-v1:${secret}:${receiverPublicKey}`).digest("hex").slice(0, 8).toUpperCase();
}

function encrypt(bundle: ShareBundle, receiverPublicKey: string) {
	const publicKey = createPublicKey({ key: Buffer.from(receiverPublicKey, "base64url"), format: "der", type: "spki" });
	if (publicKey.asymmetricKeyType !== "x25519") throw new Error("Invalid receiver key");
	const keys = generateKeyPairSync("x25519");
	const salt = randomBytes(32);
	const shared = diffieHellman({ privateKey: keys.privateKey, publicKey });
	const key = Buffer.from(hkdfSync("sha256", shared, salt, "pi-multi-pass-share-v1", 32));
	const nonce = randomBytes(12);
	const cipher = createCipheriv("aes-256-gcm", key, nonce);
	const ciphertext = Buffer.concat([cipher.update(JSON.stringify(bundle)), cipher.final()]);
	return { key: keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url"), salt: salt.toString("base64url"), nonce: nonce.toString("base64url"), data: ciphertext.toString("base64url"), tag: cipher.getAuthTag().toString("base64url") };
}

export function decodeShareUri(uri: string): { address: string; port: number; fingerprint: string; secret: string } {
	if (uri.length > 2048 || !uri.startsWith("mps-share://v1/")) throw new Error("Invalid share QR");
	let payload: unknown;
	try { payload = JSON.parse(Buffer.from(uri.slice("mps-share://v1/".length), "base64url").toString()); } catch { throw new Error("Invalid share QR"); }
	const p = payload as Record<string, unknown>;
	if (!p || typeof p.a !== "string" || !privateIPv4(p.a) || !Number.isInteger(p.p) || (p.p as number) < 1 || (p.p as number) > 65535
		|| typeof p.f !== "string" || !/^[A-F0-9]{64}$/.test(p.f) || typeof p.s !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(p.s)) throw new Error("Invalid or non-private share address");
	return { address: p.a, port: p.p as number, fingerprint: p.f, secret: p.s };
}

export async function createShareOffer(bundle: ShareBundle, address: string): Promise<ShareOffer> {
	validateBundle(bundle);
	if (!privateIPv4(address)) throw new Error("Share only on a private network address");
	const cert = await selfsigned.generate([{ name: "commonName", value: "pi-multi-pass-share" }], { keySize: 2048, notAfterDate: new Date(Date.now() + 86_400_000) });
	const fingerprint = new X509Certificate(cert.cert).fingerprint256.replaceAll(":", "").toUpperCase();
	const secret = randomBytes(32).toString("base64url");
	let resolvePending!: (value: { name: string; code: string } | null) => void;
	const pending = new Promise<{ name: string; code: string } | null>((resolve) => { resolvePending = resolve; });
	let decide!: (approved: boolean) => void;
	const decision = new Promise<boolean>((resolve) => { decide = resolve; });
	let resolveCompleted!: (delivered: boolean) => void;
	const completed = new Promise<boolean>((resolve) => { resolveCompleted = resolve; });
	let taken = false;
	let closed = false;
	let timer: ReturnType<typeof setTimeout>;
	let server: Server;
	function close() {
		if (closed) return;
		closed = true;
		clearTimeout(timer);
		decide(false);
		resolvePending(null);
		resolveCompleted(false);
		server.close();
	}
	server = createServer({ key: cert.private, cert: cert.cert }, async (req, res) => {
		res.setHeader("Cache-Control", "no-store");
		if (req.method !== "POST" || req.url !== "/v1/share" || closed || taken) { res.writeHead(404).end(); return; }
		let body = "";
		try {
			for await (const part of req) {
				body += part.toString();
				if (body.length > MAX_BODY) throw new Error("Request too large");
			}
			const input = JSON.parse(body);
			if (!fixedEqual(input.secret, secret) || typeof input.name !== "string" || input.name.length > 60 || !input.name.trim()
				|| typeof input.publicKey !== "string" || input.publicKey.length > 256) throw new Error("Invalid pairing request");
			createPublicKey({ key: Buffer.from(input.publicKey, "base64url"), format: "der", type: "spki" });
			taken = true;
			resolvePending({ name: input.name, code: codeFor(secret, input.publicKey) });
			const approved = await decision;
			if (!approved || closed) { res.writeHead(403).end(); close(); return; }
			const encrypted = encrypt(bundle, input.publicKey);
			res.setHeader("Content-Type", "application/json");
			res.end(JSON.stringify(encrypted), () => { resolveCompleted(true); close(); });
		} catch {
			res.writeHead(400).end();
		}
	});
	server.requestTimeout = 10_000;
	server.headersTimeout = 10_000;
	try {
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, address, () => { server.off("error", reject); resolve(); }); });
	} catch (error) { server.close(); throw error; }
	timer = setTimeout(close, LIFE_MS);
	const port = (server.address() as { port: number }).port;
	const uri = "mps-share://v1/" + Buffer.from(JSON.stringify({ a: address, p: port, f: fingerprint, s: secret })).toString("base64url");
	const qrText = await new Promise<string>((resolve) => qr.generate(uri, { small: true }, resolve));
	return { uri, qr: qrText, pending, completed, approve: decide, close };
}

export async function receiveShare(uri: string, name: string, onCode: (code: string) => void): Promise<ShareBundle> {
	const offer = decodeShareUri(uri);
	const keys = generateKeyPairSync("x25519");
	const publicKey = keys.publicKey.export({ format: "der", type: "spki" }).toString("base64url");
	const body = JSON.stringify({ secret: offer.secret, name: name.slice(0, 60), publicKey });
	const code = codeFor(offer.secret, publicKey);
	onCode(code);
	const response = await new Promise<string>((resolve, reject) => {
		const req = request({ hostname: offer.address, port: offer.port, path: "/v1/share", method: "POST", rejectUnauthorized: false,
			headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) }, timeout: LIFE_MS + 5_000 }, (res) => {
			let result = "";
			res.on("data", (chunk) => { result += chunk.toString(); if (result.length > 2_000_000) req.destroy(new Error("Response too large")); });
			res.on("end", () => res.statusCode === 200 ? resolve(result) : reject(new Error("Share denied or expired")));
		});
		req.on("error", reject);
		req.on("timeout", () => req.destroy(new Error("Share timed out")));
		req.on("socket", (socket) => socket.once("secureConnect", () => {
			const peer = (socket as import("node:tls").TLSSocket).getPeerCertificate(true);
			if (!peer.raw || !fixedEqual(createHash("sha256").update(peer.raw).digest("hex").toUpperCase(), offer.fingerprint)) {
				req.destroy(new Error("Sender TLS fingerprint mismatch")); return;
			}
			req.end(body);
		}));
	});
	const encrypted = JSON.parse(response);
	const senderPublic = createPublicKey({ key: Buffer.from(encrypted.key, "base64url"), format: "der", type: "spki" });
	if (senderPublic.asymmetricKeyType !== "x25519") throw new Error("Invalid sender key");
	const shared = diffieHellman({ privateKey: keys.privateKey, publicKey: senderPublic });
	const key = Buffer.from(hkdfSync("sha256", shared, Buffer.from(encrypted.salt, "base64url"), "pi-multi-pass-share-v1", 32));
	const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.nonce, "base64url"));
	decipher.setAuthTag(Buffer.from(encrypted.tag, "base64url"));
	const bundle = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted.data, "base64url")), decipher.final()]).toString()) as ShareBundle;
	validateBundle(bundle);
	return bundle;
}
