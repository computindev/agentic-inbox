// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Email sending via Cloudflare Email Service binding.
 *
 * Uses the `send_email` Worker binding (`env.EMAIL.send()`) to send emails.
 *
 * See: https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 */

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

function stripAngleBrackets(id: string): string {
	return id.trim().replace(/^<+|>+$/g, "");
}

/**
 * Send an email using the Cloudflare Email Service binding.
 *
 * @param binding  - The `EMAIL` SendEmail binding from env
 * @param params   - Email parameters (to, from, subject, body, etc.)
 * @returns The send result with messageId and wireMessageId
 * @throws On validation or delivery errors (error has `.code` property)
 */
export async function sendEmail(
	binding: SendEmail,
	params: SendEmailParams,
): Promise<{ messageId: string; wireMessageId: string }> {
	const buildPayload = (headers?: Record<string, string>) => {
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

	let explicitMsgId = "";
	if (params.headers) {
		for (const [k, v] of Object.entries(params.headers)) {
			if (k.toLowerCase() === "message-id" && v) {
				explicitMsgId = stripAngleBrackets(v);
				break;
			}
		}
	}

	try {
		const result = await binding.send(buildPayload(params.headers) as any);
		const wireMessageId =
			explicitMsgId || stripAngleBrackets(result.messageId || "");
		return { messageId: result.messageId, wireMessageId };
	} catch (err) {
		const msg = (err as Error).message || "";
		// If the binding rejects an explicit Message-ID header, retry without it
		// and adopt the provider-assigned messageId so SQLite threading stays aligned.
		if (
			params.headers &&
			/message-id/i.test(msg) &&
			/(header|forbidden|disallowed|invalid|not allowed)/i.test(msg)
		) {
			const filteredHeaders: Record<string, string> = {};
			for (const [k, v] of Object.entries(params.headers)) {
				if (k.toLowerCase() !== "message-id") {
					filteredHeaders[k] = v;
				}
			}
			const retryResult = await binding.send(
				buildPayload(filteredHeaders) as any,
			);
			const wireMessageId = stripAngleBrackets(retryResult.messageId || "");
			return { messageId: retryResult.messageId, wireMessageId };
		}
		throw err;
	}
}
