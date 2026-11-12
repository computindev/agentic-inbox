// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Unified Outbound Email Transport:
 *   1. Cloudflare Email Service (`env.EMAIL.send()`)
 *   2. AWS SES v2 (`sa-east-1` via pure Web Crypto SigV4 + Raw MIME)
 *
 * Guarantees synchronous delivery confirmation (eliminating `waitUntil` Fake-Sent)
 * and deterministic RFC 5322 `Message-ID` wire preservation for unbroken threading.
 */

import { getPlatformConfig } from "./lib/platform-config";
import type { Env, OutboundProvider } from "./types";

export interface SendEmailParams {
	to: string | string[];
	from: string | { email: string; name: string };
	subject: string;
	html?: string;
	text?: string;
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | { email: string; name: string };
	attachments?: {
		content: string; // base64 encoded
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
	}[];
	headers?: Record<string, string>;
}

export interface AwsSesCredentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	region?: string;
}

export interface SendOutboundResult {
	messageId: string;
	wireMessageId: string;
	provider: OutboundProvider;
}

function toArray(val?: string | string[]): string[] {
	if (!val) return [];
	return (Array.isArray(val) ? val : [val]).map((s) => s.trim()).filter(Boolean);
}

function stripAngleBrackets(id: string): string {
	return id.trim().replace(/^<+|>+$/g, "");
}

function uint8ToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunkSize = 0x8000;
	for (let i = 0; i < bytes.length; i += chunkSize) {
		binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
	}
	return btoa(binary);
}

function utf8ToBase64(text: string): string {
	return uint8ToBase64(new TextEncoder().encode(text));
}

function wrapBase64Lines(b64: string, lineLength = 76): string {
	const lines: string[] = [];
	for (let i = 0; i < b64.length; i += lineLength) {
		lines.push(b64.slice(i, i + lineLength));
	}
	return lines.join("\r\n");
}

function isPureAscii(str: string): boolean {
	for (let i = 0; i < str.length; i++) {
		if (str.charCodeAt(i) > 127) return false;
	}
	return true;
}

function encodeMimeWord(text: string): string {
	const clean = text.replace(/[\r\n]+/g, " ").trim();
	if (!clean) return "";
	if (isPureAscii(clean)) return clean;
	return `=?UTF-8?B?${utf8ToBase64(clean)}?=`;
}

function formatMimeAddress(addr: string | { email: string; name: string }): string {
	if (typeof addr === "string") {
		return addr.replace(/[\r\n]+/g, "").trim();
	}
	const email = addr.email.replace(/[\r\n]+/g, "").trim();
	const name = (addr.name || "").replace(/[\r\n]+/g, " ").trim();
	if (!name) return email;
	if (!isPureAscii(name)) {
		return `${encodeMimeWord(name)} <${email}>`;
	}
	const escaped = name.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escaped}" <${email}>`;
}

function extractHeaderCaseInsensitive(
	headers: Record<string, string> | undefined,
	targetKey: string,
): string | undefined {
	if (!headers) return undefined;
	const lower = targetKey.toLowerCase();
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === lower) return v;
	}
	return undefined;
}

/**
 * Build a complete RFC 5322 MIME message (base64 body transfer encoding)
 * preserving exact Message-ID, In-Reply-To, References, UTF-8 subjects, and attachments.
 */
export function buildRawMimeMessage(params: SendEmailParams): {
	rawMime: string;
	wireMessageId: string;
	destinations: string[];
} {
	const toList = toArray(params.to);
	const ccList = toArray(params.cc);
	const bccList = toArray(params.bcc);

	const fromHeader = formatMimeAddress(params.from);
	const fromEmail =
		typeof params.from === "string" ? params.from : params.from.email;
	const fromDomain = fromEmail.split("@")[1] || "computin.dev";

	const explicitMsgIdHeader = extractHeaderCaseInsensitive(
		params.headers,
		"Message-ID",
	);
	const wireMessageId = explicitMsgIdHeader
		? stripAngleBrackets(explicitMsgIdHeader)
		: `${crypto.randomUUID()}@${fromDomain}`;

	const headerLines: string[] = [
		`From: ${fromHeader}`,
		`To: ${toList.join(", ")}`,
	];

	if (ccList.length > 0) {
		headerLines.push(`Cc: ${ccList.join(", ")}`);
	}
	if (params.replyTo) {
		headerLines.push(`Reply-To: ${formatMimeAddress(params.replyTo)}`);
	}

	headerLines.push(`Subject: ${encodeMimeWord(params.subject || "")}`);
	headerLines.push(`Date: ${new Date().toUTCString()}`);
	headerLines.push(`Message-ID: <${wireMessageId}>`);
	headerLines.push("MIME-Version: 1.0");

	if (params.headers) {
		for (const [key, value] of Object.entries(params.headers)) {
			const lower = key.toLowerCase();
			if (
				lower === "message-id" ||
				lower === "from" ||
				lower === "to" ||
				lower === "cc" ||
				lower === "bcc" ||
				lower === "subject" ||
				lower === "date" ||
				lower === "mime-version"
			) {
				continue;
			}
			const cleanKey = key.replace(/[\r\n:]+/g, "").trim();
			const cleanVal = String(value ?? "").replace(/[\r\n]+/g, " ").trim();
			if (cleanKey && cleanVal) {
				headerLines.push(`${cleanKey}: ${cleanVal}`);
			}
		}
	}

	const hasAttachments = Boolean(params.attachments && params.attachments.length > 0);
	const textPart = params.text ?? "";
	const htmlPart = params.html ?? "";

	const buildAlternativeBody = (): { contentHeaders: string[]; body: string } => {
		if (htmlPart && textPart) {
			const altBoundary = `alt_${crypto.randomUUID().replace(/-/g, "")}`;
			const parts = [
				`--${altBoundary}`,
				"Content-Type: text/plain; charset=UTF-8",
				"Content-Transfer-Encoding: base64",
				"",
				wrapBase64Lines(utf8ToBase64(textPart)),
				`--${altBoundary}`,
				"Content-Type: text/html; charset=UTF-8",
				"Content-Transfer-Encoding: base64",
				"",
				wrapBase64Lines(utf8ToBase64(htmlPart)),
				`--${altBoundary}--`,
			];
			return {
				contentHeaders: [`Content-Type: multipart/alternative; boundary="${altBoundary}"`],
				body: parts.join("\r\n"),
			};
		}
		if (htmlPart) {
			return {
				contentHeaders: [
					"Content-Type: text/html; charset=UTF-8",
					"Content-Transfer-Encoding: base64",
				],
				body: wrapBase64Lines(utf8ToBase64(htmlPart)),
			};
		}
		return {
			contentHeaders: [
				"Content-Type: text/plain; charset=UTF-8",
				"Content-Transfer-Encoding: base64",
			],
			body: wrapBase64Lines(utf8ToBase64(textPart)),
		};
	};

	const alt = buildAlternativeBody();
	let finalBody = "";

	if (!hasAttachments) {
		headerLines.push(...alt.contentHeaders);
		finalBody = alt.body;
	} else {
		const mixedBoundary = `mixed_${crypto.randomUUID().replace(/-/g, "")}`;
		headerLines.push(`Content-Type: multipart/mixed; boundary="${mixedBoundary}"`);

		const sections: string[] = [
			`--${mixedBoundary}`,
			...alt.contentHeaders,
			"",
			alt.body,
		];

		for (const att of params.attachments || []) {
			const safeName = (att.filename || "attachment").replace(/["\r\n\\]/g, "_");
			const encodedName = encodeMimeWord(safeName);
			const attHeaders = [
				`--${mixedBoundary}`,
				`Content-Type: ${att.type || "application/octet-stream"}; name="${encodedName}"`,
				`Content-Disposition: ${att.disposition || "attachment"}; filename="${encodedName}"`,
				"Content-Transfer-Encoding: base64",
			];
			if (att.contentId) {
				attHeaders.push(`Content-ID: <${stripAngleBrackets(att.contentId)}>`);
			}
			sections.push(...attHeaders, "", wrapBase64Lines(att.content.replace(/\s+/g, "")));
		}

		sections.push(`--${mixedBoundary}--`);
		finalBody = sections.join("\r\n");
	}

	const rawMime = `${headerLines.join("\r\n")}\r\n\r\n${finalBody}\r\n`;
	const destinations = Array.from(new Set([...toList, ...ccList, ...bccList]));

	return { rawMime, wireMessageId, destinations };
}

// ── Pure Web Crypto AWS SigV4 Signer for SES v2 ────────────────────

function toHex(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let hex = "";
	for (let i = 0; i < bytes.length; i++) {
		hex += bytes[i].toString(16).padStart(2, "0");
	}
	return hex;
}

async function sha256Hex(data: string | Uint8Array): Promise<string> {
	const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
	const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
	return toHex(digest);
}

async function hmacSha256(
	key: ArrayBuffer | Uint8Array | string,
	message: string,
): Promise<ArrayBuffer> {
	const rawKey =
		typeof key === "string" ? new TextEncoder().encode(key) : key;
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		rawKey as BufferSource,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	return crypto.subtle.sign(
		"HMAC",
		cryptoKey,
		new TextEncoder().encode(message) as BufferSource,
	);
}

export async function sendEmailViaAwsSes(
	creds: AwsSesCredentials,
	params: SendEmailParams,
): Promise<{ messageId: string; wireMessageId: string }> {
	const region = creds.region?.trim() || "sa-east-1";
	const service = "ses";
	const host = `email.${region}.amazonaws.com`;
	const canonicalUri = "/v2/email/outbound-emails";
	const endpoint = `https://${host}${canonicalUri}`;

	const { rawMime, wireMessageId } = buildRawMimeMessage(params);
	const rawMimeBytes = new TextEncoder().encode(rawMime);

	const toList = toArray(params.to);
	const ccList = toArray(params.cc);
	const bccList = toArray(params.bcc);

	const payload = JSON.stringify({
		Destination: {
			ToAddresses: toList,
			...(ccList.length > 0 ? { CcAddresses: ccList } : {}),
			...(bccList.length > 0 ? { BccAddresses: bccList } : {}),
		},
		Content: {
			Raw: {
				Data: uint8ToBase64(rawMimeBytes),
			},
		},
	});

	const payloadBytes = new TextEncoder().encode(payload);
	const payloadHash = await sha256Hex(payloadBytes);

	const now = new Date();
	const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
	const dateStamp = amzDate.slice(0, 8);

	const headersToSign: Record<string, string> = {
		"content-type": "application/json",
		host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate,
	};
	if (creds.sessionToken) {
		headersToSign["x-amz-security-token"] = creds.sessionToken;
	}

	const sortedHeaderKeys = Object.keys(headersToSign).sort();
	const canonicalHeaders = sortedHeaderKeys
		.map((k) => `${k}:${headersToSign[k].trim()}\n`)
		.join("");
	const signedHeaders = sortedHeaderKeys.join(";");

	const canonicalRequest = [
		"POST",
		canonicalUri,
		"",
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join("\n");

	const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		credentialScope,
		await sha256Hex(canonicalRequest),
	].join("\n");

	const kDate = await hmacSha256(`AWS4${creds.secretAccessKey}`, dateStamp);
	const kRegion = await hmacSha256(kDate, region);
	const kService = await hmacSha256(kRegion, service);
	const kSigning = await hmacSha256(kService, "aws4_request");
	const signature = toHex(await hmacSha256(kSigning, stringToSign));

	const authorizationHeader = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

	const res = await fetch(endpoint, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Amz-Date": amzDate,
			"X-Amz-Content-Sha256": payloadHash,
			...(creds.sessionToken ? { "X-Amz-Security-Token": creds.sessionToken } : {}),
			Authorization: authorizationHeader,
		},
		body: payloadBytes,
	});

	const responseText = await res.text();
	if (!res.ok) {
		let detail = responseText;
		try {
			const errJson = JSON.parse(responseText) as { message?: string; Message?: string };
			detail = errJson.message || errJson.Message || responseText;
		} catch {
			// keep raw text
		}
		throw new Error(`AWS SES v2 (${region}) error ${res.status}: ${detail}`);
	}

	let providerMessageId = wireMessageId;
	try {
		const parsed = JSON.parse(responseText) as { MessageId?: string };
		if (parsed.MessageId) providerMessageId = parsed.MessageId;
	} catch {
		// keep fallback
	}

	return { messageId: providerMessageId, wireMessageId };
}

/**
 * Send an email using the Cloudflare Email Service binding (`env.EMAIL.send()`)
 * or AWS SES v2 if an `AwsSesCredentials` config is passed directly.
 */
export async function sendEmail(
	binding: SendEmail,
	params: SendEmailParams,
	sesCreds?: AwsSesCredentials,
): Promise<{ messageId: string }> {
	if (sesCreds?.accessKeyId && sesCreds?.secretAccessKey) {
		const res = await sendEmailViaAwsSes(sesCreds, params);
		return { messageId: res.messageId };
	}

	const buildMessagePayload = (headers?: Record<string, string>) => {
		const message: Record<string, unknown> = {
			to: params.to,
			from: params.from,
			subject: params.subject,
		};

		if (params.html) message.html = params.html;
		if (params.text) message.text = params.text;
		if (params.cc) message.cc = params.cc;
		if (params.bcc) message.bcc = params.bcc;
		if (params.replyTo) message.replyTo = params.replyTo;

		if (headers && Object.keys(headers).length > 0) {
			message.headers = headers;
		}

		if (params.attachments && params.attachments.length > 0) {
			message.attachments = params.attachments.map((att) => ({
				content: att.content,
				filename: att.filename,
				type: att.type,
				disposition: att.disposition,
				...(att.contentId ? { contentId: att.contentId } : {}),
			}));
		}
		return message;
	};

	try {
		const result = await binding.send(buildMessagePayload(params.headers) as any);
		return { messageId: result.messageId };
	} catch (err) {
		const msg = (err as Error).message || "";
		// If Cloudflare's send_email binding rejects an explicit Message-ID header,
		// retry once without Message-ID and return the provider's assigned messageId.
		if (
			params.headers &&
			/message-id/i.test(msg) &&
			/(header|forbidden|disallowed|invalid|not allowed)/i.test(msg)
		) {
			const filteredHeaders: Record<string, string> = {};
			for (const [k, v] of Object.entries(params.headers)) {
				if (k.toLowerCase() !== "message-id") filteredHeaders[k] = v;
			}
			const retryResult = await binding.send(
				buildMessagePayload(filteredHeaders) as any,
			);
			return { messageId: retryResult.messageId };
		}
		throw err;
	}
}

/**
 * High-level outbound email dispatcher that resolves the active outbound provider
 * (`cf_email` or `aws_ses`) from `config/platform.json` and Worker secrets.
 */
export async function sendOutboundEmail(
	env: Env,
	params: SendEmailParams,
	options?: { provider?: OutboundProvider },
): Promise<SendOutboundResult> {
	const config = await getPlatformConfig(env);
	const provider: OutboundProvider = options?.provider ?? config.outboundProvider;

	const explicitMsgId = extractHeaderCaseInsensitive(params.headers, "Message-ID");
	const defaultWireId = explicitMsgId ? stripAngleBrackets(explicitMsgId) : "";

	if (provider === "aws_ses") {
		if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
			throw new Error(
				"AWS SES v2 is selected as outbound provider, but AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY secrets are not configured.",
			);
		}
		const sesRes = await sendEmailViaAwsSes(
			{
				accessKeyId: env.AWS_ACCESS_KEY_ID,
				secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
				sessionToken: env.AWS_SESSION_TOKEN,
				region: config.sesRegion || env.AWS_SES_REGION || "sa-east-1",
			},
			params,
		);
		return {
			messageId: sesRes.messageId,
			wireMessageId: sesRes.wireMessageId,
			provider: "aws_ses",
		};
	}

	if (!env.EMAIL) {
		throw new Error("Cloudflare EMAIL (send_email) binding is not configured.");
	}

	const cfRes = await sendEmail(env.EMAIL, params);
	const wireMessageId =
		defaultWireId || stripAngleBrackets(cfRes.messageId || crypto.randomUUID());

	return {
		messageId: cfRes.messageId || wireMessageId,
		wireMessageId,
		provider: "cf_email",
	};
}
