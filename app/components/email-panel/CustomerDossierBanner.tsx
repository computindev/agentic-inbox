import { Badge, Button, useKumoToastManager } from "@cloudflare/kumo";
import {
	ArrowSquareOutIcon,
	BuildingsIcon,
	CheckCircleIcon,
	PauseCircleIcon,
	WarningCircleIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import { splitEmailList } from "~/lib/utils";
import { queryKeys } from "~/queries/keys";
import api from "~/services/api";
import type { ClientDossier, CycleEffectiveState } from "~/types";

const DEFAULT_COBRADOR_URL = "https://cobro.computincloudhosting.com";

export function extractCleanEmail(raw?: string | null): string | null {
	if (!raw) return null;
	const trimmed = raw.trim();
	const angleMatch = trimmed.match(/<([^<>@\s]+@[^<>@\s]+)>/);
	if (angleMatch?.[1]) return angleMatch[1].toLowerCase();
	const plainMatch = trimmed.match(/([^\s<>,"']+@[a-z0-9.-]+\.[a-z]{2,})/i);
	return plainMatch?.[1] ? plainMatch[1].toLowerCase() : null;
}

interface NormalizedDossier {
	clientId: string;
	clientName: string;
	rut?: string | null;
	billingGroup?: string | null;
	holdReason?: string | null;
	courtesy: boolean;
	planLabel?: string | null;
	priceUf?: number | null;
	amountClpToday?: number | null;
	cycleId?: string | null;
	dueDate?: string | null;
	cycleState?: CycleEffectiveState | null;
	payUrl?: string | null;
	adminUrl: string;
	bankReference?: string | null;
}

function normalizeDossier(
	raw: ClientDossier | null | undefined,
	fallbackCobradorUrl?: string,
): NormalizedDossier | null {
	if (!raw) return null;
	const root: Record<string, any> =
		raw.dossier && typeof raw.dossier === "object" ? raw.dossier : raw;

	if (root.found === false) return null;

	const client = root.client as Record<string, any> | null | undefined;
	const sub = root.subscription as Record<string, any> | null | undefined;
	const cycle = (root.activeCycle ?? root.cycle) as
		| Record<string, any>
		| null
		| undefined;

	const clientId: string | undefined = client?.id ?? root.clientId;
	const clientName: string | undefined =
		client?.displayName ??
		client?.name ??
		client?.razonSocial ??
		root.clientName;

	if (!clientId && !clientName) return null;

	const baseCobrador = (
		root.cobradorUrl ||
		raw.cobradorUrl ||
		fallbackCobradorUrl ||
		DEFAULT_COBRADOR_URL
	).replace(/\/+$/, "");

	const rawState: string | undefined =
		cycle?.effectiveState ??
		(cycle?.paymentClaimedAt || cycle?.payment_claimed_at
			? "payment_claimed"
			: undefined) ??
		cycle?.status ??
		root.status;

	let cycleState: CycleEffectiveState | null = null;
	if (
		rawState === "open" ||
		rawState === "payment_claimed" ||
		rawState === "paid" ||
		rawState === "waived" ||
		rawState === "cancelled"
	) {
		cycleState = rawState;
	} else if (rawState) {
		cycleState = "open";
	}

	const payToken: string | null =
		cycle?.payToken ?? cycle?.pay_token ?? root.payToken ?? null;
	const payUrl: string | null =
		cycle?.payUrl ??
		root.payUrl ??
		(payToken ? `${baseCobrador}/p/${payToken}` : null);

	const adminUrl: string =
		root.adminUrl ?? raw.adminUrl ?? `${baseCobrador}/admin`;

	const priceUfRaw =
		cycle?.priceUf ??
		cycle?.price_uf ??
		sub?.priceUf ??
		sub?.price_uf ??
		root.priceUf;
	const priceUf =
		typeof priceUfRaw === "number" && !Number.isNaN(priceUfRaw)
			? priceUfRaw
			: null;

	const clpRaw =
		cycle?.amountClpToday ??
		cycle?.amount_clp ??
		cycle?.totalClp ??
		root.amountClp;
	const amountClpToday =
		typeof clpRaw === "number" && !Number.isNaN(clpRaw) ? clpRaw : null;

	return {
		clientId: clientId || clientName || "unknown",
		clientName: clientName || clientId || "Cliente Computin",
		rut: client?.rut ?? null,
		billingGroup: client?.billingGroup ?? client?.billing_group ?? null,
		holdReason: client?.holdReason ?? client?.hold_reason ?? null,
		courtesy: Boolean(client?.courtesy),
		planLabel: sub?.planName ?? sub?.plan ?? sub?.planCode ?? root.plan ?? null,
		priceUf,
		amountClpToday,
		cycleId: cycle?.id ?? null,
		dueDate: cycle?.dueDate ?? cycle?.due_date ?? root.dueDate ?? null,
		cycleState,
		payUrl,
		adminUrl,
		bankReference: cycle?.bankReference ?? null,
	};
}

function formatClp(amount: number): string {
	return `$${new Intl.NumberFormat("es-CL", {
		maximumFractionDigits: 0,
	}).format(Math.round(amount))}`;
}

function formatUf(uf: number): string {
	return `${new Intl.NumberFormat("es-CL", {
		minimumFractionDigits: 0,
		maximumFractionDigits: 4,
	}).format(uf)} UF`;
}

function CycleStatusBadge({ state }: { state: CycleEffectiveState }) {
	switch (state) {
		case "paid":
			return <Badge variant="success">Pagado</Badge>;
		case "payment_claimed":
			return <Badge variant="beta">Aviso de pago · Pausado</Badge>;
		case "open":
			return <Badge variant="primary">Ciclo abierto</Badge>;
		case "waived":
			return <Badge variant="secondary">Eximido</Badge>;
		case "cancelled":
			return <Badge variant="outline">Cancelado</Badge>;
	}
}

interface CustomerDossierBannerProps {
	mailboxId?: string;
	mailboxEmail?: string;
	mailboxAliases?: string[];
	sender?: string;
	recipient?: string;
	emailSubject?: string;
}

export default function CustomerDossierBanner({
	mailboxId,
	mailboxEmail,
	mailboxAliases,
	sender,
	recipient,
	emailSubject,
}: CustomerDossierBannerProps) {
	const toastManager = useKumoToastManager();
	const queryClient = useQueryClient();

	const selfAddresses = useMemo(() => {
		const set = new Set<string>();
		if (mailboxId) set.add(mailboxId.toLowerCase());
		if (mailboxEmail) set.add(mailboxEmail.toLowerCase());
		for (const alias of mailboxAliases ?? []) {
			set.add(alias.toLowerCase());
		}
		return set;
	}, [mailboxId, mailboxEmail, mailboxAliases]);

	const targetEmail = useMemo(() => {
		const cleanSender = extractCleanEmail(sender);
		if (cleanSender && !selfAddresses.has(cleanSender)) {
			return cleanSender;
		}
		for (const r of splitEmailList(recipient)) {
			const cleanRecipient = extractCleanEmail(r);
			if (cleanRecipient && !selfAddresses.has(cleanRecipient)) {
				return cleanRecipient;
			}
		}
		return null;
	}, [sender, recipient, selfAddresses]);

	const { data: configData } = useQuery({
		queryKey: queryKeys.config,
		queryFn: () => api.getConfig(),
		staleTime: 60_000,
	});

	const { data: rawDossier } = useQuery({
		queryKey:
			mailboxId && targetEmail
				? queryKeys.dossier(mailboxId, targetEmail)
				: ["dossier", "_disabled"],
		queryFn: ({ signal }) =>
			api.getClientDossier(mailboxId!, targetEmail!, { signal }),
		enabled: Boolean(mailboxId && targetEmail),
		staleTime: 30_000,
		retry: false,
	});

	const dossier = useMemo(
		() => normalizeDossier(rawDossier, configData?.cobradorUrl),
		[rawDossier, configData?.cobradorUrl],
	);

	const claimPaymentMutation = useMutation({
		mutationFn: async () => {
			if (!mailboxId || !targetEmail || !dossier) {
				throw new Error("Datos insuficientes para registrar aviso de pago");
			}
			return api.claimPayment(mailboxId, {
				email: targetEmail,
				clientId: dossier.clientId,
				cycleId: dossier.cycleId ?? undefined,
				glosa: dossier.bankReference ?? undefined,
				note: emailSubject
					? `Aviso registrado desde correo: "${emailSubject}"`
					: "Aviso registrado manualmente desde Agentic Inbox",
			});
		},
		onSuccess: (res) => {
			if (mailboxId && targetEmail) {
				queryClient.invalidateQueries({
					queryKey: queryKeys.dossier(mailboxId, targetEmail),
				});
			}
			if (res.ok === false) {
				toastManager.add({
					title: res.error || res.reason || "No se pudo pausar el cobro",
					variant: "error",
				});
			} else if (res.matched === false) {
				toastManager.add({
					title: res.reason || "No se encontró un ciclo abierto para este cliente",
					variant: "error",
				});
			} else {
				toastManager.add({
					title: `Cobro en pausa para ${dossier?.clientName || targetEmail} (aviso de pago registrado)`,
				});
			}
		},
		onError: (err: unknown) => {
			const msg =
				(err instanceof Error ? err.message : null) ||
				"Error al conectar con cobrador-hosting";
			toastManager.add({ title: msg, variant: "error" });
		},
	});

	if (!dossier) return null;

	const canClaimPayment =
		dossier.cycleState === "open" && Boolean(dossier.cycleId || dossier.clientId);

	return (
		<div className="border-b border-kumo-line bg-kumo-recessed/70 px-4 py-2.5 shrink-0 md:px-6">
			<div className="flex flex-wrap items-center justify-between gap-2.5">
				{/* Left: Client identity, plan, price & cycle status */}
				<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 min-w-0 text-xs">
					<span className="inline-flex items-center gap-1.5 font-semibold text-kumo-default">
						<BuildingsIcon
							size={15}
							weight="duotone"
							className="text-kumo-brand shrink-0"
						/>
						<span>Ficha Cliente: {dossier.clientName}</span>
					</span>

					{dossier.rut && (
						<span className="text-kumo-subtle font-mono text-[11px]">
							({dossier.rut})
						</span>
					)}

					{dossier.planLabel && (
						<Badge variant="secondary">Plan {dossier.planLabel}</Badge>
					)}

					{dossier.priceUf != null && (
						<span className="font-medium text-kumo-strong">
							{formatUf(dossier.priceUf)}
							{dossier.amountClpToday != null && (
								<span className="text-kumo-subtle font-normal">
									{" "}
									· {formatClp(dossier.amountClpToday)} hoy
								</span>
							)}
						</span>
					)}

					{dossier.dueDate && (
						<span className="text-kumo-subtle">
							Vence:{" "}
							<strong className="font-medium text-kumo-default">
								{dossier.dueDate}
							</strong>
						</span>
					)}

					{dossier.cycleState && (
						<CycleStatusBadge state={dossier.cycleState} />
					)}

					{dossier.courtesy && <Badge variant="outline">Cortesía</Badge>}

					{dossier.holdReason && (
						<span
							title={dossier.holdReason}
							className="inline-flex items-center gap-1 text-[11px] text-kumo-warning font-medium"
						>
							<WarningCircleIcon size={13} weight="fill" />
							<span className="truncate max-w-[180px]">
								Hold: {dossier.holdReason}
							</span>
						</span>
					)}
				</div>

				{/* Right: Direct links & 1-click Pause / Claim Payment */}
				<div className="flex flex-wrap items-center gap-2 shrink-0">
					{dossier.payUrl && (
						<a
							href={dossier.payUrl}
							target="_blank"
							rel="noopener noreferrer"
							className="inline-flex items-center gap-1 rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-xs font-medium text-kumo-default no-underline hover:bg-kumo-tint transition-colors"
						>
							<span>/p/:token</span>
							<ArrowSquareOutIcon size={12} />
						</a>
					)}

					<a
						href={dossier.adminUrl}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-1 rounded-md border border-kumo-line bg-kumo-base px-2 py-1 text-xs font-medium text-kumo-default no-underline hover:bg-kumo-tint transition-colors"
					>
						<span>/admin</span>
						<ArrowSquareOutIcon size={12} />
					</a>

					{canClaimPayment && (
						<Button
							type="button"
							variant="secondary"
							size="xs"
							loading={claimPaymentMutation.isPending}
							icon={<PauseCircleIcon size={14} weight="bold" />}
							onClick={() => claimPaymentMutation.mutate()}
						>
							Pausar cobro / Registrar aviso de pago
						</Button>
					)}

					{dossier.cycleState === "payment_claimed" && (
						<span className="inline-flex items-center gap-1 text-xs font-medium text-kumo-success">
							<CheckCircleIcon size={14} weight="fill" />
							<span>Cobro pausado</span>
						</span>
					)}
				</div>
			</div>
		</div>
	);
}
