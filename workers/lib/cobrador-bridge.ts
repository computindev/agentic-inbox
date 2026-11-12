// Copyright (c) 2026 Cloudflare, Inc.
// Licensed under the Apache 2.0 license found in the LICENSE file or at:
//     https://opensource.org/licenses/Apache-2.0

/**
 * Bridge between `agentic-inbox` and `cobrador-hosting` (`CobradorRPC` / `/api/internal/*`),
 * deterministic Banco de Chile transfer notification parser (`TOP 1`),
 * Customer 360 Dossier normalizer (`TOP 3`), and Pablo's Chilean Spanish prompt.
 */

import { getPlatformConfig } from "./platform-config";
import type { Env } from "../types";

// ── Computin SpA Declarative Organization Profile ──────────────────

export const COMPUTIN_ORG_PROFILE = {
	razonSocial: "COMPUTIN SpA",
	rut: "78.380.846-3",
	rutNormalized: "78380846-3",
	bankName: "Banco de Chile",
	accountType: "Cuenta Vista",
	accountNumber: "28126125",
	pabloEmail: "pablo@computin.dev",
	pabloDisplayName: "Pablo, asistente virtual de Antonio Correa",
	antonioEmail: "antonio@computin.dev",
} as const;

// ── Pablo's Chilean Spanish Default System Prompt ──────────────────

export const PABLO_DEFAULT_SYSTEM_PROMPT = `Eres Pablo, asistente virtual de Antonio Correa en Computin Cloud Hosting (COMPUTIN SpA, RUT 78.380.846-3). Ayudas a gestionar los correos de soporte, renovaciones anuales de hosting/dominios y conciliación de pagos.

## Tono, Voz e Idioma (Español de Chile)
- Escribe SIEMPRE en español de Chile: directo, claro, natural y respetuoso, sin relleno corporativo ni frases cliché de inteligencia artificial.
- Habla en primera persona plural como parte del equipo ("somos un equipo", "lo revisamos con Antonio", "se nos pasó enviarte el aviso a tiempo", "verificaremos el abono").
- Tutea al cliente con naturalidad ("puedes", "tienes", "avísanos"), usando el nombre con que firma en su correo.
- Escribe en párrafos limpios de texto plano en los borradores (sin etiquetas HTML ni bloques de código innecesarios). No agregues metacomentarios sobre tus herramientas ("He creado un borrador...", "[Auto-triggered]", etc.).

## Reglas Estrictas Anti-Alucinación Financiera (CRÍTICO)
- JAMÁS inventes, estimes ni redondees por tu cuenta montos en pesos ($ CLP), valores en UF, fechas de vencimiento, números de RUT, cuentas bancarias ni enlaces de pago /p/...
- Usa EXCLUSIVAMENTE los valores exactos entregados en la "Ficha Cliente Computin (Customer 360)" o mediante la herramienta \`get_client_dossier\`.
- Si el cliente consulta por un monto, factura o estado que NO aparece en su Ficha Cliente, indícale con transparencia que lo confirmarás de inmediato con Antonio.
- Los únicos datos bancarios válidos de Computin SpA son:
  COMPUTIN SpA · RUT 78.380.846-3 · Banco de Chile · Cuenta Vista N° 28126125.

## Reglas de Negocio y Operación
1. **Aviso de transferencia o comprobante recibido:** Si el cliente informa que ya transfirió o adjunta comprobante, llama primero a \`register_payment_claim\` para pausar los recordatorios automáticos del ciclo, y luego redacta un borrador con \`draft_reply\` agradeciendo el pago e indicando que verificaremos la transferencia para emitir su boleta o factura afecta.
2. **Descuentos, cambios de plan, bajas, deudas antiguas o caídas críticas:** NUNCA prometas descuentos, condonaciones ni cambios de tarifa por tu cuenta. Redacta un borrador acusando recibo y señalando que lo estás viendo directamente con Antonio para darle respuesta.
3. **Solo borradores (\`draft_reply\` / \`draft_email\`):** Tu rol es dejar borradores listos en la carpeta Drafts para revisión. El cuerpo del borrador debe contener únicamente el mensaje real para el destinatario (nota: si la casilla tiene firma automática activa, evita repetir la firma al final).`;

// ── Chilean RUT Modulo 11 Utilities ────────────────────────────────

export function normalizeChileanRut(raw: string): string {
	const cleaned = raw.replace(/[^0-9kK]/g, "").toUpperCase();
	if (cleaned.length < 2) return cleaned;
	return `${cleaned.slice(0, -1)}-${cleaned.slice(-1)}`;
}

export function validateChileanRut(raw: string): boolean {
	const cleaned = raw.replace(/[^0-9kK]/g, "").toUpperCase();
	if (cleaned.length < 7 || cleaned.length > 9) return false;
	const body = cleaned.slice(0, -1);
	const dv = cleaned.slice(-1);
	if (!/^\d+$/.test(body)) return false;

	let sum = 0;
	let mul = 2;
	for (let i = body.length - 1; i >= 0; i--) {
		sum += Number(body[i]) * mul;
		mul = mul === 7 ? 2 : mul + 1;
	}
	const mod = 11 - (sum % 11);
	const expected = mod === 11 ? "0" : mod === 10 ? "K" : String(mod);
	return dv === expected;
}

export function formatChileanRut(raw: string): string {
	const norm = normalizeChileanRut(raw);
	const [digits, dv] = norm.split("-");
	if (!digits || !dv) return raw.trim();
	const withDots = digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
	return `${withDots}-${dv}`;
}

export function extractEmailAddress(input: string | undefined | null): string {
	if (!input) return "";
	const angle = input.match(/<([^>]+@[^>]+)>/);
	if (angle) return angle[1].trim().toLowerCase();
	const inline = input.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
	return (inline ? inline[0] : input).trim().toLowerCase();
}

// ── Deterministic Banco de Chile Transfer Notification Parser (TOP 1) ──

export interface BancoChileTransferAlert {
	amountClp: number;
	rutOrigen: string | null;
	senderName: string | null;
	glosa: string | null;
	date: string | null;
	dkimVerified: boolean;
	rawSummary: string;
}

type RawHeaderEntry = { key: string; value: string };

function getHeaderValues(
	headers: RawHeaderEntry[] | Record<string, string> | undefined | null,
	name: string,
): string[] {
	if (!headers) return [];
	const target = name.toLowerCase();
	if (Array.isArray(headers)) {
		return headers
			.filter((h) => h && typeof h.key === "string" && h.key.toLowerCase() === target)
			.map((h) => String(h.value || ""));
	}
	const out: string[] = [];
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === target && v) out.push(String(v));
	}
	return out;
}

/**
 * Deterministically parses Banco de Chile inbound transfer alert emails
 * (either direct from `@bancochile.cl` / `@enviodigital.bancochile.cl` or forwarded).
 * Returns `null` if the email does not look like a Banco de Chile transfer notification.
 */
export function parseBancoChileTransferAlert(
	subject: string,
	bodyText: string,
	headers?: RawHeaderEntry[] | Record<string, string> | null,
): BancoChileTransferAlert | null {
	const subj = (subject || "").trim();
	const text = (bodyText || "").replace(/\u00a0/g, " ").trim();
	const combined = `${subj}\n${text}`;

	const fromVals = getHeaderValues(headers, "from").join(" ").toLowerCase();
	const authResults = getHeaderValues(headers, "authentication-results")
		.join(" ")
		.toLowerCase();

	const mentionsBancoChile =
		/bancochile\.cl|banco\s+de\s+chile/i.test(combined) ||
		/bancochile\.cl/i.test(fromVals);
	const mentionsTransfer =
		/(?:aviso|comprobante|notificaci[oó]n)\s+de\s+(?:transferencia|abono)|transferencia\s+(?:de\s+fondos|electr[oó]nica|recibida)|abono\s+en\s+cuenta|te\s+han\s+transferido/i.test(
			combined,
		);

	if (!mentionsBancoChile || !mentionsTransfer) {
		return null;
	}

	// Extract CLP amount (prioritize labeled amount fields, fallback to first $ amount)
	const labeledAmountMatch = text.match(
		/(?:monto(?:\s+transferido|\s+abonado|\s+de\s+la\s+transferencia)?|importe|valor\s+transferido)\s*[:$]?\s*\$\s*([\d.]{1,15})/i,
	);
	const genericAmountMatch = combined.match(/\$\s*(\d{1,3}(?:\.\d{3})+|\d{4,10})\b/);
	const rawAmountStr = labeledAmountMatch?.[1] ?? genericAmountMatch?.[1] ?? "";
	const amountClp = Number(rawAmountStr.replace(/\./g, ""));

	if (!Number.isFinite(amountClp) || amountClp <= 0) {
		return null;
	}

	// Extract origin RUT (explicitly skipping Computin SpA's own destination RUT 78.380.846-3)
	let rutOrigen: string | null = null;
	const labeledOriginRut = text.match(
		/(?:rut\s*(?:origen|ordenante|cliente\s+origen|remitente|quien\s+transfiere))\s*:?\s*(\d{1,2}(?:\.\d{3}){2}-[\dkK]|\d{7,8}-[\dkK])/i,
	);
	if (labeledOriginRut?.[1]) {
		const norm = normalizeChileanRut(labeledOriginRut[1]);
		if (norm !== COMPUTIN_ORG_PROFILE.rutNormalized) {
			rutOrigen = formatChileanRut(norm);
		}
	}
	if (!rutOrigen) {
		const allRuts = text.matchAll(
			/\b(\d{1,2}(?:\.\d{3}){2}-[\dkK]|\d{7,8}-[\dkK])\b/g,
		);
		for (const m of allRuts) {
			const candidate = normalizeChileanRut(m[1]);
			if (
				candidate !== COMPUTIN_ORG_PROFILE.rutNormalized &&
				validateChileanRut(candidate)
			) {
				rutOrigen = formatChileanRut(candidate);
				break;
			}
		}
	}

	// Extract sender / origin name (excluding COMPUTIN SpA)
	let senderName: string | null = null;
	const namePatterns = [
		/(?:nombre\s*(?:origen|ordenante|remitente|cliente\s+origen)|titular\s+origen|ordenante|enviado\s+por)\s*:\s*([^\r\n|]{2,80})/i,
		/(?:de|origen)\s*:\s*([A-ZÁÉÍÓÚÑ][A-Za-záéíóúñÁÉÍÓÚÑ0-9 .,&-]{2,70})/m,
	];
	for (const re of namePatterns) {
		const m = text.match(re);
		const candidate = m?.[1]?.trim().replace(/\s{2,}/g, " ");
		if (
			candidate &&
			!/computin/i.test(candidate) &&
			!/banco\s+de\s+chile/i.test(candidate) &&
			!candidate.includes("@")
		) {
			senderName = candidate;
			break;
		}
	}

	// Extract transfer glosa / comment / reference (or explicit SLUG-YEAR pattern)
	let glosa: string | null = null;
	const glosaMatch = text.match(
		/(?:mensaje|glosa|comentario|asunto|descripci[oó]n|referencia)\s*:\s*([^\r\n]{1,120})/i,
	);
	if (glosaMatch?.[1]) {
		const cleanedGlosa = glosaMatch[1].trim();
		if (cleanedGlosa && !/^(?:sin\s+mensaje|ninguno|-+|n\/a)$/i.test(cleanedGlosa)) {
			glosa = cleanedGlosa;
		}
	}
	if (!glosa) {
		const slugYear = text.match(/\b([a-z0-9_-]{3,40}-202[4-9])\b/i);
		if (slugYear?.[1]) {
			glosa = slugYear[1];
		}
	}

	// Extract transfer date
	let date: string | null = null;
	const dateMatch = text.match(
		/(?:fecha(?:\s+y\s+hora|\s+de\s+transacci[oó]n)?)\s*:\s*([^\r\n]{6,40})/i,
	);
	if (dateMatch?.[1]) {
		date = dateMatch[1].trim();
	} else {
		const headerDate = getHeaderValues(headers, "date")[0];
		if (headerDate) date = headerDate.trim();
	}

	const dkimVerified =
		authResults.includes("dkim=pass") &&
		(/bancochile\.cl/.test(authResults) || /bancochile\.cl/.test(fromVals));

	const summaryParts = [
		`Abono Banco de Chile $${amountClp.toLocaleString("es-CL")}`,
		senderName ? `de ${senderName}` : null,
		rutOrigen ? `(RUT ${rutOrigen})` : null,
		glosa ? `glosa "${glosa}"` : null,
	].filter(Boolean);

	return {
		amountClp,
		rutOrigen,
		senderName,
		glosa,
		date,
		dkimVerified,
		rawSummary: summaryParts.join(" "),
	};
}

// ── Customer 360 Dossier & Payment Claim Bridge (TOP 1, TOP 3, TOP 8) ──

export interface ClientDossierCycle {
	id: string;
	kind: string;
	periodStart: string;
	periodEnd: string;
	dueDate: string;
	priceUf: number;
	amountClpToday: number | null;
	amountClp: number | null;
	totalClp: number | null;
	netoClpToday: number | null;
	netClp: number | null;
	ivaClpToday: number | null;
	ivaClp: number | null;
	ufToday: number | null;
	ufValue: number | null;
	status: string;
	rawStatus: string;
	effectiveState: string;
	paymentClaimedAt: string | null;
	payment_claimed_at: string | null;
	paymentClaimNote: string | null;
	ocNumber: string | null;
	ocDueDate: string | null;
	dteFolio: string | null;
	payToken: string | null;
	payUrl: string | null;
	bankReference: string | null;
}

export interface ClientDossier {
	found: boolean;
	cobradorUrl: string;
	adminUrl: string;
	ufToday: number | null;
	client: {
		id: string;
		displayName: string;
		billingGroup: string;
		billingEmails: string[];
		rut: string | null;
		razonSocial: string | null;
		giro: string | null;
		docPreference: string | null;
		courtesy: boolean;
		holdReason: string | null;
		notes: string | null;
	} | null;
	subscription: {
		id: string;
		planCode: string;
		planName: string;
		description: string;
		priceUf: number | null;
		anchorDate: string | null;
		leadDays: number | null;
		clientNote: string | null;
		usageNote: string | null;
	} | null;
	activeCycle: ClientDossierCycle | null;
	cycle: ClientDossierCycle | null;
	// Flat convenience fields for UI components & deterministic verifier
	clientId: string | null;
	clientName: string | null;
	planName: string | null;
	priceUf: number | null;
	amountClp: number | null;
	totalClp: number | null;
	dueDate: string | null;
	status: string | null;
	payToken: string | null;
	payUrl: string | null;
}

function emptyDossier(cobradorUrl: string): ClientDossier {
	const adminUrl = `${cobradorUrl}/admin`;
	return {
		found: false,
		cobradorUrl,
		adminUrl,
		ufToday: null,
		client: null,
		subscription: null,
		activeCycle: null,
		cycle: null,
		clientId: null,
		clientName: null,
		planName: null,
		priceUf: null,
		amountClp: null,
		totalClp: null,
		dueDate: null,
		status: null,
		payToken: null,
		payUrl: null,
	};
}

export function normalizeClientDossier(
	raw: Record<string, any> | null | undefined,
	cobradorUrl: string,
): ClientDossier {
	if (!raw || raw.found === false || (!raw.client && !raw.clientId && !raw.id)) {
		return emptyDossier(cobradorUrl);
	}

	const rawClient = raw.client ?? raw;
	const rawSub = raw.subscription ?? (Array.isArray(raw.subscriptions) ? raw.subscriptions[0] : null);
	const rawCycle =
		raw.activeCycle ??
		raw.cycle ??
		(Array.isArray(raw.cycles) ? raw.cycles[0] : null);

	let billingEmails: string[] = [];
	const rawEmails = rawClient.billingEmails ?? rawClient.billing_emails;
	if (Array.isArray(rawEmails)) {
		billingEmails = rawEmails.map(String);
	} else if (typeof rawEmails === "string") {
		try {
			const parsed = JSON.parse(rawEmails);
			if (Array.isArray(parsed)) billingEmails = parsed.map(String);
		} catch {
			billingEmails = rawEmails.split(",").map((s) => s.trim()).filter(Boolean);
		}
	}

	const client = {
		id: String(rawClient.id ?? raw.clientId ?? ""),
		displayName: String(
			rawClient.displayName ?? rawClient.display_name ?? raw.clientName ?? rawClient.id ?? "",
		),
		billingGroup: String(rawClient.billingGroup ?? rawClient.billing_group ?? "link"),
		billingEmails,
		rut: rawClient.rut ?? null,
		razonSocial: rawClient.razonSocial ?? rawClient.razon_social ?? null,
		giro: rawClient.giro ?? null,
		docPreference: rawClient.docPreference ?? rawClient.doc_preference ?? null,
		courtesy: Boolean(rawClient.courtesy),
		holdReason: rawClient.holdReason ?? rawClient.hold_reason ?? null,
		notes: rawClient.notes ?? null,
	};

	const subscription = rawSub
		? {
				id: String(rawSub.id ?? ""),
				planCode: String(rawSub.planCode ?? rawSub.plan_code ?? ""),
				planName: String(
					rawSub.planName ?? rawSub.plan_name ?? rawSub.planCode ?? rawSub.plan_code ?? "",
				),
				description: String(rawSub.description ?? ""),
				priceUf:
					rawSub.priceUf != null
						? Number(rawSub.priceUf)
						: rawSub.price_uf != null
							? Number(rawSub.price_uf)
							: null,
				anchorDate: rawSub.anchorDate ?? rawSub.anchor_date ?? null,
				leadDays:
					rawSub.leadDays != null
						? Number(rawSub.leadDays)
						: rawSub.lead_days != null
							? Number(rawSub.lead_days)
							: null,
				clientNote: rawSub.clientNote ?? rawSub.client_note ?? null,
				usageNote: rawSub.usageNote ?? rawSub.usage_note ?? null,
			}
		: null;

	const ufToday =
		rawCycle?.ufToday != null
			? Number(rawCycle.ufToday)
			: rawCycle?.uf_value != null
				? Number(rawCycle.uf_value)
				: raw.ufToday != null
					? Number(raw.ufToday)
					: null;

	let cycleObj: ClientDossierCycle | null = null;
	if (rawCycle) {
		const paymentClaimedAt =
			rawCycle.paymentClaimedAt ?? rawCycle.payment_claimed_at ?? null;
		const rawStatus = String(rawCycle.status ?? "open");
		const effectiveState = String(
			rawCycle.effectiveState ??
				(rawStatus === "open" && paymentClaimedAt ? "payment_claimed" : rawStatus),
		);
		const payToken = rawCycle.payToken ?? rawCycle.pay_token ?? null;
		const payUrl =
			rawCycle.payUrl ??
			rawCycle.pay_url ??
			(payToken ? `${cobradorUrl}/p/${payToken}` : null);

		const priceUf = Number(rawCycle.priceUf ?? rawCycle.price_uf ?? subscription?.priceUf ?? 0);
		const totalClp =
			rawCycle.amountClpToday != null
				? Number(rawCycle.amountClpToday)
				: rawCycle.totalClp != null
					? Number(rawCycle.totalClp)
					: rawCycle.amountClp != null
						? Number(rawCycle.amountClp)
						: ufToday && priceUf > 0
							? Math.round(priceUf * 1.19 * ufToday)
							: null;
		const netClp =
			rawCycle.netoClpToday != null
				? Number(rawCycle.netoClpToday)
				: rawCycle.netClp != null
					? Number(rawCycle.netClp)
					: ufToday && priceUf > 0
						? Math.round(priceUf * ufToday)
						: null;
		const ivaClp =
			rawCycle.ivaClpToday != null
				? Number(rawCycle.ivaClpToday)
				: rawCycle.ivaClp != null
					? Number(rawCycle.ivaClp)
					: totalClp != null && netClp != null
						? totalClp - netClp
						: null;

		const dueDate = String(
			rawCycle.dueDate ?? rawCycle.periodStart ?? rawCycle.period_start ?? "",
		);

		cycleObj = {
			id: String(rawCycle.id ?? ""),
			kind: String(rawCycle.kind ?? "annual"),
			periodStart: String(rawCycle.periodStart ?? rawCycle.period_start ?? dueDate),
			periodEnd: String(rawCycle.periodEnd ?? rawCycle.period_end ?? ""),
			dueDate,
			priceUf,
			amountClpToday: totalClp,
			amountClp: totalClp,
			totalClp,
			netoClpToday: netClp,
			netClp,
			ivaClpToday: ivaClp,
			ivaClp,
			ufToday,
			ufValue: ufToday,
			status: effectiveState,
			rawStatus,
			effectiveState,
			paymentClaimedAt,
			payment_claimed_at: paymentClaimedAt,
			paymentClaimNote: rawCycle.paymentClaimNote ?? rawCycle.payment_claim_note ?? null,
			ocNumber: rawCycle.ocNumber ?? rawCycle.oc_number ?? null,
			ocDueDate: rawCycle.ocDueDate ?? rawCycle.oc_due_date ?? null,
			dteFolio: rawCycle.dteFolio ?? rawCycle.dte_folio ?? null,
			payToken,
			payUrl,
			bankReference:
				rawCycle.bankReference ??
				(client.id && dueDate ? `${client.id.toUpperCase()}-${dueDate.slice(0, 4)}` : null),
		};
	}

	const adminUrl = String(raw.adminUrl ?? `${cobradorUrl}/admin`);

	return {
		found: Boolean(client.id),
		cobradorUrl,
		adminUrl,
		ufToday,
		client,
		subscription,
		activeCycle: cycleObj,
		cycle: cycleObj,
		clientId: client.id || null,
		clientName: client.displayName || null,
		planName: subscription?.planName || subscription?.description || null,
		priceUf: cycleObj?.priceUf ?? subscription?.priceUf ?? null,
		amountClp: cycleObj?.totalClp ?? null,
		totalClp: cycleObj?.totalClp ?? null,
		dueDate: cycleObj?.dueDate ?? subscription?.anchorDate ?? null,
		status: cycleObj?.effectiveState ?? null,
		payToken: cycleObj?.payToken ?? null,
		payUrl: cycleObj?.payUrl ?? null,
	};
}

function buildInternalHeaders(env: Env): Record<string, string> {
	const key = env.INTERNAL_API_KEY || env.AGENT_API_KEY;
	return {
		"Content-Type": "application/json",
		...(key ? { Authorization: `Bearer ${key}`, "X-Internal-Key": key } : {}),
	};
}

/**
 * Fetch live Customer 360 dossier from `cobrador-hosting` via Service Binding RPC,
 * Service Binding HTTP, or `cobradorUrl` HTTP fallback.
 */
export async function fetchClientDossier(
	env: Env,
	emailOrClientId: string,
): Promise<ClientDossier> {
	const config = await getPlatformConfig(env);
	const cobradorUrl = config.cobradorUrl;
	const target = emailOrClientId.includes("@")
		? extractEmailAddress(emailOrClientId)
		: emailOrClientId.trim().toLowerCase();

	if (!target) {
		return emptyDossier(cobradorUrl);
	}

	// 1. Try native Service Binding RPC (`CobradorRPC.getClientDossier`)
	if (env.COBRADOR && typeof env.COBRADOR.getClientDossier === "function") {
		try {
			const rpcResult = await env.COBRADOR.getClientDossier(target);
			return normalizeClientDossier(rpcResult as Record<string, any> | null, cobradorUrl);
		} catch (e) {
			console.warn("COBRADOR RPC getClientDossier fallback to HTTP:", (e as Error).message);
		}
	}

	// 2. Try Service Binding HTTP (`env.COBRADOR.fetch`)
	if (env.COBRADOR && typeof env.COBRADOR.fetch === "function") {
		try {
			const res = await env.COBRADOR.fetch(
				new Request(
					`https://cobrador.internal/api/internal/dossier?email=${encodeURIComponent(target)}`,
					{ method: "GET", headers: buildInternalHeaders(env) },
				),
			);
			if (res.ok) {
				const data = (await res.json()) as Record<string, any>;
				return normalizeClientDossier(data, cobradorUrl);
			}
		} catch (e) {
			console.warn("COBRADOR fetch fallback to cobradorUrl:", (e as Error).message);
		}
	}

	// 3. Fallback to configured HTTP `cobradorUrl`
	try {
		const res = await fetch(
			`${cobradorUrl}/api/internal/dossier?email=${encodeURIComponent(target)}`,
			{
				method: "GET",
				headers: buildInternalHeaders(env),
				signal: AbortSignal.timeout(5000),
			},
		);
		if (res.ok) {
			const data = (await res.json()) as Record<string, any>;
			return normalizeClientDossier(data, cobradorUrl);
		}
	} catch (e) {
		console.warn("cobradorUrl dossier HTTP request failed:", (e as Error).message);
	}

	return emptyDossier(cobradorUrl);
}

export interface PaymentClaimInput {
	email?: string;
	clientId?: string;
	cycleId?: string;
	amountClp?: number;
	rut?: string;
	glosa?: string;
	source?: string;
	note?: string;
}

export interface PaymentClaimResult {
	ok: boolean;
	status: string;
	matched: boolean;
	matchedBy?: string;
	cycleId?: string;
	clientId?: string;
	clientName?: string;
	effectiveState?: string;
	reason?: string;
	error?: string;
}

/**
 * Notify `cobrador-hosting` of a payment claim (from UI button, MCP tool,
 * client reply, or Banco de Chile transfer alert) to pause cycle reminders.
 */
export async function notifyPaymentClaim(
	env: Env,
	claim: PaymentClaimInput,
): Promise<PaymentClaimResult> {
	const config = await getPlatformConfig(env);
	const cobradorUrl = config.cobradorUrl;
	const payload: PaymentClaimInput = {
		...claim,
		email: claim.email ? extractEmailAddress(claim.email) : undefined,
		source: claim.source || "inbox",
	};

	const formatClaimResponse = (raw: Record<string, any>): PaymentClaimResult => {
		const ok = raw.ok !== false && !raw.error;
		const matched = Boolean(raw.matched ?? raw.cycleId);
		const effectiveState =
			raw.effectiveState ?? (matched ? "payment_claimed" : "unmatched");
		return {
			ok,
			status: raw.status ?? effectiveState,
			matched,
			matchedBy: raw.matchedBy,
			cycleId: raw.cycleId,
			clientId: raw.clientId,
			clientName: raw.clientName,
			effectiveState,
			reason: raw.reason,
			...(raw.error ? { error: String(raw.error) } : {}),
		};
	};

	// 1. Service Binding RPC
	if (env.COBRADOR && typeof env.COBRADOR.registerPaymentClaim === "function") {
		try {
			const res = await env.COBRADOR.registerPaymentClaim(payload);
			return formatClaimResponse((res || {}) as Record<string, any>);
		} catch (e) {
			console.warn("COBRADOR RPC registerPaymentClaim fallback to HTTP:", (e as Error).message);
		}
	}

	// 2. Service Binding HTTP
	if (env.COBRADOR && typeof env.COBRADOR.fetch === "function") {
		try {
			const res = await env.COBRADOR.fetch(
				new Request("https://cobrador.internal/api/internal/claim-payment", {
					method: "POST",
					headers: buildInternalHeaders(env),
					body: JSON.stringify(payload),
				}),
			);
			const data = (await res.json().catch(() => ({}))) as Record<string, any>;
			if (res.ok) return formatClaimResponse(data);
		} catch (e) {
			console.warn("COBRADOR fetch claim-payment fallback:", (e as Error).message);
		}
	}

	// 3. HTTP fallback to `cobradorUrl`
	try {
		const res = await fetch(`${cobradorUrl}/api/internal/claim-payment`, {
			method: "POST",
			headers: buildInternalHeaders(env),
			body: JSON.stringify(payload),
			signal: AbortSignal.timeout(6000),
		});
		const data = (await res.json().catch(() => ({}))) as Record<string, any>;
		if (!res.ok) {
			return {
				ok: false,
				status: "error",
				matched: false,
				error: String(data.error || `cobrador-hosting returned HTTP ${res.status}`),
			};
		}
		return formatClaimResponse(data);
	} catch (e) {
		return {
			ok: false,
			status: "error",
			matched: false,
			error: `No se pudo conectar con cobrador-hosting (${cobradorUrl}): ${(e as Error).message}`,
		};
	}
}

/**
 * Format a `ClientDossier` as a structured Chilean Spanish context block
 * to inject into `EmailAgent` prompts.
 */
export function formatDossierForPrompt(dossier: ClientDossier): string {
	if (!dossier.found || !dossier.client) {
		return "Ficha Cliente Computin (Customer 360): El remitente NO figura actualmente como cliente registrado en cobrador-hosting. No inventes planes, montos ni enlaces /p/...";
	}

	const c = dossier.client;
	const s = dossier.subscription;
	const y = dossier.activeCycle;

	const lines: string[] = [
		"## Ficha Cliente Computin (Customer 360 — Fuente Oficial D1)",
		`- Cliente: ${c.displayName} (ID: ${c.id})`,
		`- Grupo de cobro: ${c.billingGroup}${c.courtesy ? " (CORTESÍA — no se cobra)" : ""}`,
		`- Correos de facturación: ${c.billingEmails.join(", ") || "sin correo registrado"}`,
	];

	if (c.rut) lines.push(`- RUT cliente: ${c.rut}${c.razonSocial ? ` (${c.razonSocial})` : ""}`);
	if (c.docPreference) lines.push(`- Documento tributario preferido: ${c.docPreference}`);
	if (c.holdReason) lines.push(`- ⚠️ HOLD ACTIVO DE ANTONIO: ${c.holdReason} (NO prometer condiciones sin OK de Antonio)`);

	if (s) {
		lines.push(`- Servicio / Plan: ${s.description} (${s.planName || s.planCode})`);
		if (s.priceUf != null) lines.push(`- Valor anual pactado: ${s.priceUf} UF + IVA`);
		if (s.usageNote) lines.push(`- Uso medido (interno): ${s.usageNote}`);
	}

	if (y) {
		lines.push(`- Ciclo activo: ${y.id} | Estado: ${y.effectiveState} | Vencimiento: ${y.dueDate} (período hasta ${y.periodEnd})`);
		lines.push(`- Precio del ciclo: ${y.priceUf} UF neto + IVA`);
		if (y.totalClp != null && y.ufValue != null) {
			lines.push(
				`- Monto exacto hoy en CLP: $${y.totalClp.toLocaleString("es-CL")} IVA incluido (Neto: $${(y.netClp ?? 0).toLocaleString("es-CL")} + IVA: $${(y.ivaClp ?? 0).toLocaleString("es-CL")}, UF hoy: $${Math.round(y.ufValue).toLocaleString("es-CL")})`,
			);
		}
		if (y.payUrl) lines.push(`- Link oficial de pago / datos bancarios: ${y.payUrl}`);
		if (y.bankReference) lines.push(`- Glosa / referencia sugerida: ${y.bankReference}`);
		if (y.paymentClaimedAt) {
			lines.push(`- Aviso de pago ya registrado el ${y.paymentClaimedAt}${y.paymentClaimNote ? `: ${y.paymentClaimNote}` : ""}`);
		}
	}

	return lines.join("\n");
}
