import { createId } from "@paralleldrive/cuid2";
import { relations, sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	doublePrecision,
	foreignKey,
	index,
	integer,
	jsonb,
	type PgTableExtraConfigValue,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { bytea, decimal } from "./columns";
import * as enums from "./enums";
import type { JsonValue } from "./json";

export const mcpConnectionStatusEnum = pgEnum(
	"McpConnectionStatus",
	enums.McpConnectionStatus,
);
export const mcpAccessModeEnum = pgEnum("McpAccessMode", enums.McpAccessMode);
export const mcpToolReviewStateEnum = pgEnum(
	"McpToolReviewState",
	enums.McpToolReviewState,
);
export const dealStageEnum = pgEnum("DealStage", enums.DealStage);
export const activityTypeEnum = pgEnum("ActivityType", enums.ActivityType);
export const enrichmentStatusEnum = pgEnum(
	"EnrichmentStatus",
	enums.EnrichmentStatus,
);
export const recordSourceEnum = pgEnum("RecordSource", enums.RecordSource);
export const agentConversationKindEnum = pgEnum(
	"AgentConversationKind",
	enums.AgentConversationKind,
);
export const agentDefinitionStatusEnum = pgEnum(
	"AgentDefinitionStatus",
	enums.AgentDefinitionStatus,
);
export const agentVersionStatusEnum = pgEnum(
	"AgentVersionStatus",
	enums.AgentVersionStatus,
);
export const agentBuilderArtifactStatusEnum = pgEnum(
	"AgentBuilderArtifactStatus",
	enums.AgentBuilderArtifactStatus,
);
export const agentTriggerTypeEnum = pgEnum(
	"AgentTriggerType",
	enums.AgentTriggerType,
);
export const agentRunStatusEnum = pgEnum(
	"AgentRunStatus",
	enums.AgentRunStatus,
);
export const agentActionStatusEnum = pgEnum(
	"AgentActionStatus",
	enums.AgentActionStatus,
);
export const agentConversationShareScopeEnum = pgEnum(
	"AgentConversationShareScope",
	enums.AgentConversationShareScope,
);
export const agentConversationSubmissionStatusEnum = pgEnum(
	"AgentConversationSubmissionStatus",
	enums.AgentConversationSubmissionStatus,
);
export const agentConversationCommandTypeEnum = pgEnum(
	"AgentConversationCommandType",
	enums.AgentConversationCommandType,
);
export const agentConversationPermissionModeEnum = pgEnum(
	"AgentConversationPermissionMode",
	enums.AgentConversationPermissionMode,
);
export const agentResponseRatingEnum = pgEnum(
	"AgentResponseRating",
	enums.AgentResponseRating,
);
export const factBandEnum = pgEnum("FactBand", enums.FactBand);
export const factStatusEnum = pgEnum("FactStatus", enums.FactStatus);
export const rateSourceEnum = pgEnum("RateSource", enums.RateSource);
export const fieldEntityEnum = pgEnum("FieldEntity", enums.FieldEntity);
export const fieldTypeEnum = pgEnum("FieldType", enums.FieldType);
export const googleSyncStatusEnum = pgEnum(
	"GoogleSyncStatus",
	enums.GoogleSyncStatus,
);
export const emailDirectionEnum = pgEnum(
	"EmailDirection",
	enums.EmailDirection,
);
export const domainScopeEnum = pgEnum("DomainScope", enums.DomainScope);

export const user = pgTable(
	"user",
	{
		id: text().primaryKey(),
		name: text().notNull(),
		email: text().notNull(),
		emailVerified: boolean().notNull().default(false),
		image: text(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("user_email_key").on(table.email),
	],
);

export const slackMemberMatch = pgTable(
	"slackMemberMatch",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		crmUserId: text().notNull(),
		slackUserId: text(),
		slackHandle: text(),
		slackEmail: text(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("slackMemberMatch_crmUserId_key").on(table.crmUserId),
		index("slackMemberMatch_slackUserId_idx").on(table.slackUserId),
		foreignKey({
			name: "slackMemberMatch_crmUserId_fkey",
			columns: [table.crmUserId],
			foreignColumns: [user.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const slackChannel = pgTable(
	"slackChannel",
	{
		id: text().primaryKey(),
		name: text().notNull(),
		memberCount: integer(),
		available: boolean().notNull().default(true),
		isPrivate: boolean().notNull().default(false),
		isMember: boolean().notNull().default(false),
		inviteRequestedAt: timestamp({ precision: 3, mode: "date" }),
		classifiedAt: timestamp({ precision: 3, mode: "date" }),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		index("slackChannel_available_name_idx").on(table.available, table.name),
		index("slackChannel_updatedAt_idx").on(table.updatedAt),
	],
);

export const slackInstallation = pgTable("slackInstallation", {
	installerId: text().primaryKey(),
	teamId: text().notNull(),
	teamName: text(),
	userToken: text(),
	userScopes: text().notNull(),
	createdAt: timestamp({ precision: 3, mode: "date" })
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`)
		.$defaultFn(() => new Date()),
});

export const slackWorkspaceGrant = pgTable(
	"slackWorkspaceGrant",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		teamId: text().notNull(),
		teamName: text(),
		userToken: text().notNull(),
		userScopes: text().notNull(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("slackWorkspaceGrant_teamId_key").on(table.teamId),
	],
);

export const session = pgTable(
	"session",
	{
		id: text().primaryKey(),
		expiresAt: timestamp({ precision: 3, mode: "date" }).notNull(),
		token: text().notNull(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
		ipAddress: text(),
		userAgent: text(),
		userId: text().notNull(),
		activeOrganizationId: text(),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("session_token_key").on(table.token),
		index("session_userId_idx").on(table.userId),
		foreignKey({
			name: "session_userId_fkey",
			columns: [table.userId],
			foreignColumns: [user.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const account = pgTable(
	"account",
	{
		id: text().primaryKey(),
		accountId: text().notNull(),
		providerId: text().notNull(),
		userId: text().notNull(),
		accessToken: text(),
		refreshToken: text(),
		idToken: text(),
		accessTokenExpiresAt: timestamp({ precision: 3, mode: "date" }),
		refreshTokenExpiresAt: timestamp({ precision: 3, mode: "date" }),
		scope: text(),
		password: text(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		index("account_userId_idx").on(table.userId),
		foreignKey({
			name: "account_userId_fkey",
			columns: [table.userId],
			foreignColumns: [user.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const mcpConnection = pgTable(
	"mcpConnection",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		organizationId: text().notNull(),
		platformSlug: text().notNull(),
		status: mcpConnectionStatusEnum().notNull().default("CONNECTING"),
		accessMode: mcpAccessModeEnum().notNull(),
		grantedScopes: text().array(),
		encryptedAccessToken: text(),
		encryptedRefreshToken: text(),
		tokenExpiresAt: timestamp({ precision: 3, mode: "date" }),
		registrationId: text().notNull(),
		connectedById: text().notNull(),
		connectedAt: timestamp({ precision: 3, mode: "date" }),
		lastSuccessfulCallAt: timestamp({ precision: 3, mode: "date" }),
		lastErrorCode: text(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("mcpConnection_organizationId_platformSlug_key").on(
			table.organizationId,
			table.platformSlug,
		),
		index("mcpConnection_status_updatedAt_idx").on(
			table.status,
			table.updatedAt,
		),
		foreignKey({
			name: "mcpConnection_organizationId_fkey",
			columns: [table.organizationId],
			foreignColumns: [organization.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "mcpConnection_registrationId_fkey",
			columns: [table.registrationId],
			foreignColumns: [mcpClientRegistration.id],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
		foreignKey({
			name: "mcpConnection_connectedById_fkey",
			columns: [table.connectedById],
			foreignColumns: [user.id],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
	],
);

export const mcpClientRegistration = pgTable(
	"mcpClientRegistration",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		platformSlug: text().notNull(),
		metadataFingerprint: text().notNull(),
		issuer: text().notNull(),
		clientId: text().notNull(),
		encryptedClientSecret: text(),
		encryptedRegistrationAccessToken: text(),
		clientIdIssuedAt: timestamp({ precision: 3, mode: "date" }),
		clientSecretExpiresAt: timestamp({ precision: 3, mode: "date" }),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex(
			"mcpClientRegistration_platformSlug_metadataFingerprint_key",
		).on(table.platformSlug, table.metadataFingerprint),
		index("mcpClientRegistration_clientSecretExpiresAt_idx").on(
			table.clientSecretExpiresAt,
		),
	],
);

export const mcpToolSnapshot = pgTable(
	"mcpToolSnapshot",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		connectionId: text().notNull(),
		name: text().notNull(),
		description: text(),
		inputSchema: jsonb().$type<JsonValue>().notNull(),
		annotations: jsonb().$type<JsonValue>(),
		fingerprint: text().notNull(),
		callKind: text().notNull(),
		reviewState: mcpToolReviewStateEnum().notNull().default("PENDING"),
		lastSeenAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("mcpToolSnapshot_connectionId_name_fingerprint_key").on(
			table.connectionId,
			table.name,
			table.fingerprint,
		),
		index("mcpToolSnapshot_connectionId_name_lastSeenAt_idx").on(
			table.connectionId,
			table.name,
			table.lastSeenAt,
		),
		index("mcpToolSnapshot_reviewState_lastSeenAt_idx").on(
			table.reviewState,
			table.lastSeenAt,
		),
		foreignKey({
			name: "mcpToolSnapshot_connectionId_fkey",
			columns: [table.connectionId],
			foreignColumns: [mcpConnection.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const mcpOauthState = pgTable(
	"mcpOauthState",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		stateHash: text().notNull(),
		organizationId: text().notNull(),
		userId: text().notNull(),
		platformSlug: text().notNull(),
		accessMode: mcpAccessModeEnum().notNull(),
		returnPath: text().notNull(),
		encryptedCodeVerifier: text().notNull(),
		registrationId: text().notNull(),
		expiresAt: timestamp({ precision: 3, mode: "date" }).notNull(),
		consumedAt: timestamp({ precision: 3, mode: "date" }),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("mcpOauthState_stateHash_key").on(table.stateHash),
		index("mcpOauthState_expiresAt_consumedAt_idx").on(
			table.expiresAt,
			table.consumedAt,
		),
		foreignKey({
			name: "mcpOauthState_organizationId_fkey",
			columns: [table.organizationId],
			foreignColumns: [organization.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "mcpOauthState_userId_fkey",
			columns: [table.userId],
			foreignColumns: [user.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "mcpOauthState_registrationId_fkey",
			columns: [table.registrationId],
			foreignColumns: [mcpClientRegistration.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const verification = pgTable(
	"verification",
	{
		id: text().primaryKey(),
		identifier: text().notNull(),
		value: text().notNull(),
		expiresAt: timestamp({ precision: 3, mode: "date" }).notNull(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		index("verification_identifier_idx").on(table.identifier),
	],
);

export const rateLimit = pgTable(
	"rateLimit",
	{
		id: text().primaryKey(),
		key: text().notNull(),
		count: integer().notNull(),
		lastRequest: bigint({ mode: "number" }).notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("rateLimit_key_key").on(table.key),
	],
);

export const company = pgTable(
	"company",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		name: text().notNull(),
		domain: text(),
		website: text(),
		description: text(),
		logoUrl: text(),
		logoDarkUrl: text(),
		iconUrl: text(),
		iconDarkUrl: text(),
		iconTone: text(),
		brandColor: text(),
		industry: text(),
		subIndustry: text(),
		city: text(),
		stateCode: text(),
		country: text(),
		countryCode: text(),
		phone: text(),
		email: text(),
		linkedinUrl: text(),
		twitterUrl: text(),
		githubUrl: text(),
		pricingUrl: text(),
		careersUrl: text(),
		ownerId: text(),
		primaryContactId: text(),
		enrichmentStatus: enrichmentStatusEnum().notNull().default("PENDING"),
		enrichedAt: timestamp({ precision: 3, mode: "date" }),
		enrichmentError: text(),
		source: recordSourceEnum().notNull().default("MANUAL"),
		lastActivityAt: timestamp({ precision: 3, mode: "date" }),
		archivedAt: timestamp({ precision: 3, mode: "date" }),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("company_primaryContactId_key").on(table.primaryContactId),
		uniqueIndex("company_domain_active_key")
			.on(table.domain)
			.where(sql`"archivedAt" IS NULL`),
		index("company_ownerId_idx").on(table.ownerId),
		index("company_name_idx").on(table.name),
		index("company_lastActivityAt_idx").on(table.lastActivityAt),
		index("company_archivedAt_idx").on(table.archivedAt),
		foreignKey({
			name: "company_ownerId_fkey",
			columns: [table.ownerId],
			foreignColumns: [user.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
		foreignKey({
			name: "company_primaryContactId_fkey",
			columns: [table.primaryContactId],
			foreignColumns: [contact.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
	],
);

export const companyEnrichment = pgTable(
	"companyEnrichment",
	{
		companyId: text().primaryKey(),
		source: text().notNull().default("context.dev"),
		raw: jsonb().$type<JsonValue>().notNull(),
		fetchedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "companyEnrichment_companyId_fkey",
			columns: [table.companyId],
			foreignColumns: [company.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const contact = pgTable(
	"contact",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		firstName: text().notNull(),
		lastName: text(),
		email: text(),
		phone: text(),
		title: text(),
		seniority: text(),
		function: text(),
		linkedinUrl: text(),
		twitterUrl: text(),
		githubUrl: text(),
		imageUrl: text(),
		socialsCheckedAt: timestamp({ precision: 3, mode: "date" }),
		enrichmentStatus: enrichmentStatusEnum().notNull().default("PENDING"),
		enrichedAt: timestamp({ precision: 3, mode: "date" }),
		enrichmentError: text(),
		companyId: text(),
		ownerId: text(),
		source: recordSourceEnum().notNull().default("MANUAL"),
		lastActivityAt: timestamp({ precision: 3, mode: "date" }),
		archivedAt: timestamp({ precision: 3, mode: "date" }),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("contact_email_active_key")
			.on(table.email)
			.where(sql`"archivedAt" IS NULL`),
		index("contact_companyId_idx").on(table.companyId),
		index("contact_ownerId_idx").on(table.ownerId),
		index("contact_lastActivityAt_idx").on(table.lastActivityAt),
		index("contact_archivedAt_idx").on(table.archivedAt),
		foreignKey({
			name: "contact_companyId_fkey",
			columns: [table.companyId],
			foreignColumns: [company.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
		foreignKey({
			name: "contact_ownerId_fkey",
			columns: [table.ownerId],
			foreignColumns: [user.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
	],
);

export const contactFact = pgTable(
	"contactFact",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		contactId: text().notNull(),
		field: text().notNull(),
		value: text().notNull(),
		score: doublePrecision().notNull(),
		band: factBandEnum().notNull(),
		evidence: jsonb().$type<JsonValue>().notNull(),
		method: text().notNull(),
		sourceUrl: text(),
		sessionId: text(),
		status: factStatusEnum().notNull().default("PROPOSED"),
		decidedById: text(),
		decidedAt: timestamp({ precision: 3, mode: "date" }),
		observedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		supersededAt: timestamp({ precision: 3, mode: "date" }),
	},
	(table): PgTableExtraConfigValue[] => [
		index("contactFact_contactId_field_status_idx").on(
			table.contactId,
			table.field,
			table.status,
		),
		index("contactFact_status_observedAt_idx").on(
			table.status,
			table.observedAt,
		),
		foreignKey({
			name: "contactFact_contactId_fkey",
			columns: [table.contactId],
			foreignColumns: [contact.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "contactFact_decidedById_fkey",
			columns: [table.decidedById],
			foreignColumns: [user.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
	],
);

export const contactBrief = pgTable(
	"contactBrief",
	{
		contactId: text().primaryKey(),
		narrative: text().notNull(),
		sections: jsonb().$type<JsonValue>().notNull(),
		score: doublePrecision().notNull(),
		sourceUrl: text(),
		sessionId: text(),
		refreshedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		foreignKey({
			name: "contactBrief_contactId_fkey",
			columns: [table.contactId],
			foreignColumns: [contact.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const agentTask = pgTable(
	"agentTask",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		contactId: text(),
		companyId: text(),
		dealId: text(),
		kind: text().notNull(),
		reason: text().notNull(),
		payload: jsonb().$type<JsonValue>(),
		priority: integer().notNull().default(0),
		budget: integer().notNull().default(4),
		attempts: integer().notNull().default(0),
		dueAt: timestamp({ precision: 3, mode: "date" }).notNull(),
		leasedUntil: timestamp({ precision: 3, mode: "date" }),
		sessionId: text(),
		startedAt: timestamp({ precision: 3, mode: "date" }),
		finishedAt: timestamp({ precision: 3, mode: "date" }),
		outcome: text(),
		subject: text(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		index("agentTask_dueAt_leasedUntil_idx").on(table.dueAt, table.leasedUntil),
		index("agentTask_contactId_idx").on(table.contactId),
		index("agentTask_dealId_idx").on(table.dealId),
		index("agentTask_kind_subject_idx")
			.on(table.kind, table.subject)
			.where(sql`"finishedAt" IS NULL`),
	],
);

export const agentEvent = pgTable(
	"agentEvent",
	{
		id: text().primaryKey(),
		sessionId: text().notNull(),
		streamIndex: integer(),
		deliveryIds: text().array().notNull().default(sql`ARRAY[]::text[]`),
		contactId: text(),
		conversationId: text(),
		type: text().notNull(),
		data: jsonb().$type<JsonValue>().notNull(),
		encryptedData: text(),
		emittedAt: timestamp({ precision: 3, mode: "date" }).notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		index("agentEvent_sessionId_emittedAt_idx").on(
			table.sessionId,
			table.emittedAt,
		),
		uniqueIndex("agentEvent_sessionId_streamIndex_key").on(
			table.sessionId,
			table.streamIndex,
		),
		index("agentEvent_contactId_emittedAt_idx").on(
			table.contactId,
			table.emittedAt,
		),
		index("agentEvent_conversationId_emittedAt_idx").on(
			table.conversationId,
			table.emittedAt,
		),
		foreignKey({
			name: "agentEvent_conversationId_fkey",
			columns: [table.conversationId],
			foreignColumns: [agentConversation.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const agentConversation = pgTable(
	"agentConversation",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		kind: agentConversationKindEnum().notNull().default("RECORD"),
		contactId: text(),
		companyId: text(),
		dealId: text(),
		userId: text().notNull(),
		agentId: text(),
		sessionId: text(),
		continuationToken: text(),
		streamIndex: integer().notNull().default(0),
		pendingInputRequests: jsonb().$type<JsonValue>(),
		permissionMode: agentConversationPermissionModeEnum()
			.notNull()
			.default("MANUAL"),
		title: text(),
		messageCount: integer().notNull().default(0),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
		lastMessageAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		lastAssistantAt: timestamp({ precision: 3, mode: "date" }),
		lastReadAt: timestamp({ precision: 3, mode: "date" }),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("agentConversation_sessionId_key").on(table.sessionId),
		index("agentConversation_contactId_lastMessageAt_idx").on(
			table.contactId,
			table.lastMessageAt,
		),
		index("agentConversation_companyId_lastMessageAt_idx").on(
			table.companyId,
			table.lastMessageAt,
		),
		index("agentConversation_dealId_lastMessageAt_idx").on(
			table.dealId,
			table.lastMessageAt,
		),
		index("agentConversation_userId_kind_lastMessageAt_idx").on(
			table.userId,
			table.kind,
			table.lastMessageAt,
		),
		index("agentConversation_agentId_lastMessageAt_idx").on(
			table.agentId,
			table.lastMessageAt,
		),
		foreignKey({
			name: "agentConversation_contactId_fkey",
			columns: [table.contactId],
			foreignColumns: [contact.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentConversation_companyId_fkey",
			columns: [table.companyId],
			foreignColumns: [company.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentConversation_dealId_fkey",
			columns: [table.dealId],
			foreignColumns: [deal.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentConversation_userId_fkey",
			columns: [table.userId],
			foreignColumns: [user.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentConversation_agentId_fkey",
			columns: [table.agentId],
			foreignColumns: [agentDefinition.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
	],
);

export const agentConversationFeedback = pgTable(
	"agentConversationFeedback",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		conversationId: text().notNull(),
		userId: text().notNull(),
		messageId: text().notNull(),
		rating: agentResponseRatingEnum().notNull(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex(
			"agentConversationFeedback_conversationId_userId_messageId_key",
		).on(table.conversationId, table.userId, table.messageId),
		index("agentConversationFeedback_conversationId_createdAt_idx").on(
			table.conversationId,
			table.createdAt,
		),
		foreignKey({
			name: "agentConversationFeedback_conversationId_fkey",
			columns: [table.conversationId],
			foreignColumns: [agentConversation.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentConversationFeedback_userId_fkey",
			columns: [table.userId],
			foreignColumns: [user.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const agentConversationShare = pgTable(
	"agentConversationShare",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		conversationId: text().notNull(),
		createdById: text().notNull(),
		scope: agentConversationShareScopeEnum()
			.notNull()
			.default("WORKSPACE_LINK"),
		tokenHash: text().notNull(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		expiresAt: timestamp({ precision: 3, mode: "date" }),
		revokedAt: timestamp({ precision: 3, mode: "date" }),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("agentConversationShare_tokenHash_key").on(table.tokenHash),
		uniqueIndex("agentConversationShare_one_active_per_conversation")
			.on(table.conversationId)
			.where(sql`"revokedAt" IS NULL`),
		index("agentConversationShare_conversationId_revokedAt_idx").on(
			table.conversationId,
			table.revokedAt,
		),
		foreignKey({
			name: "agentConversationShare_conversationId_fkey",
			columns: [table.conversationId],
			foreignColumns: [agentConversation.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentConversationShare_createdById_fkey",
			columns: [table.createdById],
			foreignColumns: [user.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const agentConversationSubmission = pgTable(
	"agentConversationSubmission",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		conversationId: text().notNull(),
		submittedById: text().notNull(),
		clientRequestId: text().notNull(),
		inputRequestId: text(),
		commandType: agentConversationCommandTypeEnum().notNull().default("CHAT"),
		message: jsonb().$type<JsonValue>().notNull(),
		status: agentConversationSubmissionStatusEnum()
			.notNull()
			.default("PENDING"),
		attemptCount: integer().notNull().default(0),
		errorCode: text(),
		errorMessage: text(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		sentAt: timestamp({ precision: 3, mode: "date" }),
		acceptedAt: timestamp({ precision: 3, mode: "date" }),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("agentConversationSubmission_clientRequestId_key").on(
			table.clientRequestId,
		),
		uniqueIndex(
			"agentConversationSubmission_conversationId_inputRequestId_key",
		).on(table.conversationId, table.inputRequestId),
		index("agentConversationSubmission_conversationId_createdAt_idx").on(
			table.conversationId,
			table.createdAt,
		),
		index("agentConversationSubmission_status_createdAt_idx").on(
			table.status,
			table.createdAt,
		),
		foreignKey({
			name: "agentConversationSubmission_conversationId_fkey",
			columns: [table.conversationId],
			foreignColumns: [agentConversation.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentConversationSubmission_submittedById_fkey",
			columns: [table.submittedById],
			foreignColumns: [user.id],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
	],
);

export const agentConversationAttachment = pgTable(
	"agentConversationAttachment",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		submissionId: text().notNull(),
		name: text().notNull(),
		mediaType: text().notNull(),
		size: integer().notNull(),
		content: bytea().notNull(),
		position: integer().notNull(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		index("agentConversationAttachment_submissionId_position_idx").on(
			table.submissionId,
			table.position,
		),
		foreignKey({
			name: "agentConversationAttachment_submissionId_fkey",
			columns: [table.submissionId],
			foreignColumns: [agentConversationSubmission.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const agentDefinition = pgTable(
	"agentDefinition",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		name: text().notNull(),
		description: text(),
		status: agentDefinitionStatusEnum().notNull().default("DRAFT"),
		createdById: text().notNull(),
		currentVersionId: text(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
		archivedAt: timestamp({ precision: 3, mode: "date" }),
		deletedAt: timestamp({ precision: 3, mode: "date" }),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("agentDefinition_currentVersionId_key").on(
			table.currentVersionId,
		),
		uniqueIndex("agentDefinition_currentVersionId_id_key").on(
			table.currentVersionId,
			table.id,
		),
		index("agentDefinition_status_updatedAt_idx").on(
			table.status,
			table.updatedAt,
		),
		index("agentDefinition_createdById_createdAt_idx").on(
			table.createdById,
			table.createdAt,
		),
		foreignKey({
			name: "agentDefinition_createdById_fkey",
			columns: [table.createdById],
			foreignColumns: [user.id],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentDefinition_currentVersionId_id_fkey",
			columns: [table.currentVersionId, table.id],
			foreignColumns: [agentVersion.id, agentVersion.agentId],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
	],
);

export const agentVersion = pgTable(
	"agentVersion",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		agentId: text().notNull(),
		number: integer().notNull(),
		status: agentVersionStatusEnum().notNull().default("DRAFT"),
		instructions: text().notNull(),
		manifest: jsonb().$type<JsonValue>().notNull(),
		modelId: text().notNull(),
		modelContextWindowTokens: integer().notNull().default(1000000),
		sandboxPolicy: jsonb().$type<JsonValue>().notNull(),
		validation: jsonb().$type<JsonValue>(),
		sourceConversationId: text(),
		createdById: text().notNull(),
		deploymentId: text(),
		approvedAt: timestamp({ precision: 3, mode: "date" }),
		deployedAt: timestamp({ precision: 3, mode: "date" }),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("agentVersion_agentId_number_key").on(
			table.agentId,
			table.number,
		),
		uniqueIndex("agentVersion_id_agentId_key").on(table.id, table.agentId),
		index("agentVersion_agentId_createdAt_idx").on(
			table.agentId,
			table.createdAt,
		),
		index("agentVersion_status_createdAt_idx").on(
			table.status,
			table.createdAt,
		),
		foreignKey({
			name: "agentVersion_agentId_fkey",
			columns: [table.agentId],
			foreignColumns: [agentDefinition.id],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentVersion_sourceConversationId_fkey",
			columns: [table.sourceConversationId],
			foreignColumns: [agentConversation.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentVersion_createdById_fkey",
			columns: [table.createdById],
			foreignColumns: [user.id],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
	],
);

export const agentBuilderArtifact = pgTable(
	"agentBuilderArtifact",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		conversationId: text(),
		versionId: text(),
		path: text().notNull(),
		language: text().notNull(),
		content: text().notNull(),
		previousContent: text(),
		revision: integer().notNull(),
		status: agentBuilderArtifactStatusEnum().notNull().default("WRITING"),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("agentBuilderArtifact_conversation_path_revision_key")
			.on(table.conversationId, table.path, table.revision)
			.where(sql`"conversationId" IS NOT NULL`),
		uniqueIndex("agentBuilderArtifact_version_path_revision_key")
			.on(table.versionId, table.path, table.revision)
			.where(sql`"versionId" IS NOT NULL`),
		index("agentBuilderArtifact_conversationId_createdAt_idx").on(
			table.conversationId,
			table.createdAt,
		),
		index("agentBuilderArtifact_versionId_path_idx").on(
			table.versionId,
			table.path,
		),
		foreignKey({
			name: "agentBuilderArtifact_conversationId_fkey",
			columns: [table.conversationId],
			foreignColumns: [agentConversation.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentBuilderArtifact_versionId_fkey",
			columns: [table.versionId],
			foreignColumns: [agentVersion.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
		check(
			"agentBuilderArtifact_owner_present",
			sql`${table.conversationId} IS NOT NULL OR ${table.versionId} IS NOT NULL`,
		),
	],
);

export const agentTrigger = pgTable(
	"agentTrigger",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		agentId: text().notNull(),
		versionId: text().notNull(),
		type: agentTriggerTypeEnum().notNull(),
		name: text().notNull(),
		config: jsonb().$type<JsonValue>().notNull(),
		createdById: text().notNull(),
		enabled: boolean().notNull().default(false),
		nextRunAt: timestamp({ precision: 3, mode: "date" }),
		lastRunAt: timestamp({ precision: 3, mode: "date" }),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("agentTrigger_id_agentId_key").on(table.id, table.agentId),
		index("agentTrigger_agentId_enabled_idx").on(table.agentId, table.enabled),
		index("agentTrigger_enabled_nextRunAt_idx").on(
			table.enabled,
			table.nextRunAt,
		),
		index("agentTrigger_versionId_idx").on(table.versionId),
		foreignKey({
			name: "agentTrigger_agentId_fkey",
			columns: [table.agentId],
			foreignColumns: [agentDefinition.id],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentTrigger_versionId_agentId_fkey",
			columns: [table.versionId, table.agentId],
			foreignColumns: [agentVersion.id, agentVersion.agentId],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentTrigger_createdById_fkey",
			columns: [table.createdById],
			foreignColumns: [user.id],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
	],
);

export const agentRun = pgTable(
	"agentRun",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		agentId: text().notNull(),
		versionId: text().notNull(),
		triggerId: text(),
		initiatedById: text(),
		triggerType: agentTriggerTypeEnum().notNull(),
		status: agentRunStatusEnum().notNull().default("QUEUED"),
		principalId: text(),
		sessionId: text(),
		idempotencyKey: text().notNull(),
		correlationId: text().notNull(),
		input: jsonb().$type<JsonValue>(),
		result: jsonb().$type<JsonValue>(),
		summary: text(),
		modelId: text(),
		inputTokens: integer(),
		outputTokens: integer(),
		costUsd: decimal({ precision: 12, scale: 6 }),
		errorCode: text(),
		errorMessage: text(),
		nextEventSequence: integer().notNull().default(0),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		startedAt: timestamp({ precision: 3, mode: "date" }),
		finishedAt: timestamp({ precision: 3, mode: "date" }),
		cancelRequestedAt: timestamp({ precision: 3, mode: "date" }),
		cancelDeliveredAt: timestamp({ precision: 3, mode: "date" }),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("agentRun_sessionId_key").on(table.sessionId),
		uniqueIndex("agentRun_idempotencyKey_key").on(table.idempotencyKey),
		uniqueIndex("agentRun_correlationId_key").on(table.correlationId),
		uniqueIndex("agentRun_id_agentId_key").on(table.id, table.agentId),
		index("agentRun_agentId_createdAt_idx").on(table.agentId, table.createdAt),
		index("agentRun_versionId_createdAt_idx").on(
			table.versionId,
			table.createdAt,
		),
		index("agentRun_status_createdAt_idx").on(table.status, table.createdAt),
		index("agentRun_triggerId_createdAt_idx").on(
			table.triggerId,
			table.createdAt,
		),
		foreignKey({
			name: "agentRun_agentId_fkey",
			columns: [table.agentId],
			foreignColumns: [agentDefinition.id],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentRun_versionId_agentId_fkey",
			columns: [table.versionId, table.agentId],
			foreignColumns: [agentVersion.id, agentVersion.agentId],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentRun_triggerId_agentId_fkey",
			columns: [table.triggerId, table.agentId],
			foreignColumns: [agentTrigger.id, agentTrigger.agentId],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentRun_initiatedById_fkey",
			columns: [table.initiatedById],
			foreignColumns: [user.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
	],
);

export const agentRunEvent = pgTable(
	"agentRunEvent",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		runId: text().notNull(),
		sequence: integer().notNull(),
		type: text().notNull(),
		data: jsonb().$type<JsonValue>().notNull(),
		emittedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("agentRunEvent_runId_sequence_key").on(
			table.runId,
			table.sequence,
		),
		index("agentRunEvent_runId_emittedAt_idx").on(table.runId, table.emittedAt),
		foreignKey({
			name: "agentRunEvent_runId_fkey",
			columns: [table.runId],
			foreignColumns: [agentRun.id],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
	],
);

export const agentAction = pgTable(
	"agentAction",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		agentId: text().notNull(),
		runId: text().notNull(),
		type: text().notNull(),
		provider: text().notNull(),
		targetType: text(),
		targetId: text(),
		targetLabel: text(),
		summary: text().notNull(),
		metadata: jsonb().$type<JsonValue>(),
		status: agentActionStatusEnum().notNull().default("PLANNED"),
		idempotencyKey: text().notNull(),
		requestHash: text(),
		externalId: text(),
		attemptCount: integer().notNull().default(0),
		errorCode: text(),
		errorMessage: text(),
		plannedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		startedAt: timestamp({ precision: 3, mode: "date" }),
		completedAt: timestamp({ precision: 3, mode: "date" }),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("agentAction_idempotencyKey_key").on(table.idempotencyKey),
		index("agentAction_agentId_plannedAt_idx").on(
			table.agentId,
			table.plannedAt,
		),
		index("agentAction_runId_plannedAt_idx").on(table.runId, table.plannedAt),
		index("agentAction_provider_externalId_idx").on(
			table.provider,
			table.externalId,
		),
		index("agentAction_status_plannedAt_idx").on(table.status, table.plannedAt),
		foreignKey({
			name: "agentAction_agentId_fkey",
			columns: [table.agentId],
			foreignColumns: [agentDefinition.id],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentAction_runId_agentId_fkey",
			columns: [table.runId, table.agentId],
			foreignColumns: [agentRun.id, agentRun.agentId],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
	],
);

export const agentAuditEvent = pgTable(
	"agentAuditEvent",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		agentId: text().notNull(),
		versionId: text(),
		actorUserId: text(),
		type: text().notNull(),
		actorType: text().notNull(),
		actorId: text(),
		summary: text().notNull(),
		before: jsonb().$type<JsonValue>(),
		after: jsonb().$type<JsonValue>(),
		requestId: text(),
		emittedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("agentAuditEvent_agentId_type_requestId_key").on(
			table.agentId,
			table.type,
			table.requestId,
		),
		index("agentAuditEvent_agentId_emittedAt_idx").on(
			table.agentId,
			table.emittedAt,
		),
		index("agentAuditEvent_versionId_emittedAt_idx").on(
			table.versionId,
			table.emittedAt,
		),
		index("agentAuditEvent_actorUserId_emittedAt_idx").on(
			table.actorUserId,
			table.emittedAt,
		),
		index("agentAuditEvent_type_emittedAt_idx").on(table.type, table.emittedAt),
		foreignKey({
			name: "agentAuditEvent_agentId_fkey",
			columns: [table.agentId],
			foreignColumns: [agentDefinition.id],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentAuditEvent_versionId_agentId_fkey",
			columns: [table.versionId, table.agentId],
			foreignColumns: [agentVersion.id, agentVersion.agentId],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
		foreignKey({
			name: "agentAuditEvent_actorUserId_fkey",
			columns: [table.actorUserId],
			foreignColumns: [user.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
	],
);

export const deal = pgTable(
	"deal",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		name: text().notNull(),
		description: text(),
		companyId: text().notNull(),
		ownerId: text().notNull(),
		stage: dealStageEnum().notNull().default("DEMO_BOOKED"),
		stageChangedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		amount: decimal({ precision: 14, scale: 2 }),
		currency: text().notNull().default("USD"),
		expectedCloseDate: timestamp({ precision: 3, mode: "date" }),
		closedAt: timestamp({ precision: 3, mode: "date" }),
		closedReason: text(),
		baseAmount: decimal({ precision: 24, scale: 4 }),
		baseCurrency: text(),
		fxRate: decimal({ precision: 20, scale: 10 }),
		fxRateAt: timestamp({ precision: 3, mode: "date" }),
		lastActivityAt: timestamp({ precision: 3, mode: "date" }),
		archivedAt: timestamp({ precision: 3, mode: "date" }),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		index("deal_companyId_idx").on(table.companyId),
		index("deal_ownerId_idx").on(table.ownerId),
		index("deal_stage_idx").on(table.stage),
		index("deal_expectedCloseDate_idx").on(table.expectedCloseDate),
		index("deal_lastActivityAt_idx").on(table.lastActivityAt),
		index("deal_baseAmount_idx").on(table.baseAmount),
		index("deal_currency_idx").on(table.currency),
		index("deal_archivedAt_idx").on(table.archivedAt),
		foreignKey({
			name: "deal_companyId_fkey",
			columns: [table.companyId],
			foreignColumns: [company.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "deal_ownerId_fkey",
			columns: [table.ownerId],
			foreignColumns: [user.id],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
	],
);

export const exchangeRate = pgTable(
	"exchangeRate",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		baseCurrency: text().notNull(),
		quoteCurrency: text().notNull(),
		rate: decimal({ precision: 20, scale: 10 }).notNull(),
		asOf: timestamp({ precision: 3, mode: "date" }).notNull(),
		source: rateSourceEnum().notNull(),
		provider: text(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("exchangeRate_baseCurrency_quoteCurrency_source_key").on(
			table.baseCurrency,
			table.quoteCurrency,
			table.source,
		),
		index("exchangeRate_baseCurrency_quoteCurrency_idx").on(
			table.baseCurrency,
			table.quoteCurrency,
		),
	],
);

export const dealContact = pgTable(
	"dealContact",
	{
		dealId: text().notNull(),
		contactId: text().notNull(),
		role: text(),
	},
	(table): PgTableExtraConfigValue[] => [
		primaryKey({
			name: "dealContact_pkey",
			columns: [table.dealId, table.contactId],
		}),
		index("dealContact_contactId_idx").on(table.contactId),
		foreignKey({
			name: "dealContact_dealId_fkey",
			columns: [table.dealId],
			foreignColumns: [deal.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "dealContact_contactId_fkey",
			columns: [table.contactId],
			foreignColumns: [contact.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const fieldDefinition = pgTable(
	"fieldDefinition",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		entity: fieldEntityEnum().notNull(),
		key: text().notNull(),
		label: text().notNull(),
		type: fieldTypeEnum().notNull(),
		agentFilled: boolean().notNull().default(true),
		agentBrief: text(),
		required: boolean().notNull().default(false),
		showOnSheet: boolean().notNull().default(true),
		showOnTable: boolean().notNull().default(false),
		showOnFilter: boolean().notNull().default(false),
		position: integer().notNull(),
		archivedAt: timestamp({ precision: 3, mode: "date" }),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("fieldDefinition_entity_key_key").on(table.entity, table.key),
		index("fieldDefinition_entity_position_idx").on(
			table.entity,
			table.position,
		),
	],
);

export const fieldOption = pgTable(
	"fieldOption",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		fieldId: text().notNull(),
		label: text().notNull(),
		position: integer().notNull(),
		archivedAt: timestamp({ precision: 3, mode: "date" }),
	},
	(table): PgTableExtraConfigValue[] => [
		index("fieldOption_fieldId_position_idx").on(table.fieldId, table.position),
		foreignKey({
			name: "fieldOption_fieldId_fkey",
			columns: [table.fieldId],
			foreignColumns: [fieldDefinition.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const fieldValue = pgTable(
	"fieldValue",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		fieldId: text().notNull(),
		companyId: text(),
		contactId: text(),
		dealId: text(),
		text: text(),
		number: decimal({ precision: 24, scale: 4 }),
		date: timestamp({ precision: 3, mode: "date" }),
		bool: boolean(),
		optionId: text(),
		userId: text(),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("fieldValue_fieldId_companyId_key").on(
			table.fieldId,
			table.companyId,
		),
		uniqueIndex("fieldValue_fieldId_contactId_key").on(
			table.fieldId,
			table.contactId,
		),
		uniqueIndex("fieldValue_fieldId_dealId_key").on(
			table.fieldId,
			table.dealId,
		),
		index("fieldValue_fieldId_text_idx").on(table.fieldId, table.text),
		index("fieldValue_fieldId_number_idx").on(table.fieldId, table.number),
		index("fieldValue_fieldId_date_idx").on(table.fieldId, table.date),
		index("fieldValue_companyId_idx").on(table.companyId),
		index("fieldValue_contactId_idx").on(table.contactId),
		index("fieldValue_dealId_idx").on(table.dealId),
		index("fieldValue_optionId_idx").on(table.optionId),
		index("fieldValue_userId_idx").on(table.userId),
		foreignKey({
			name: "fieldValue_fieldId_fkey",
			columns: [table.fieldId],
			foreignColumns: [fieldDefinition.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "fieldValue_companyId_fkey",
			columns: [table.companyId],
			foreignColumns: [company.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "fieldValue_contactId_fkey",
			columns: [table.contactId],
			foreignColumns: [contact.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "fieldValue_dealId_fkey",
			columns: [table.dealId],
			foreignColumns: [deal.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "fieldValue_optionId_fkey",
			columns: [table.optionId],
			foreignColumns: [fieldOption.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
		foreignKey({
			name: "fieldValue_userId_fkey",
			columns: [table.userId],
			foreignColumns: [user.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
	],
);

export const savedView = pgTable(
	"savedView",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		entity: fieldEntityEnum().notNull(),
		name: text().notNull(),
		shared: boolean().notNull().default(false),
		filters: jsonb().$type<JsonValue>().notNull(),
		ownerId: text().notNull(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("savedView_entity_ownerId_name_key").on(
			table.entity,
			table.ownerId,
			table.name,
		),
		index("savedView_entity_shared_idx").on(table.entity, table.shared),
		foreignKey({
			name: "savedView_ownerId_fkey",
			columns: [table.ownerId],
			foreignColumns: [user.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const activity = pgTable(
	"activity",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		type: activityTypeEnum().notNull(),
		subject: text(),
		body: text(),
		occurredAt: timestamp({ precision: 3, mode: "date" }),
		dueAt: timestamp({ precision: 3, mode: "date" }),
		completedAt: timestamp({ precision: 3, mode: "date" }),
		companyId: text(),
		contactId: text(),
		dealId: text(),
		createdById: text().notNull(),
		meta: jsonb().$type<JsonValue>(),
		emailThreadId: text(),
		calendarEventId: text(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("activity_emailThreadId_key").on(table.emailThreadId),
		uniqueIndex("activity_calendarEventId_key").on(table.calendarEventId),
		index("activity_companyId_createdAt_idx").on(
			table.companyId,
			table.createdAt,
		),
		index("activity_dealId_createdAt_idx").on(table.dealId, table.createdAt),
		index("activity_contactId_createdAt_idx").on(
			table.contactId,
			table.createdAt,
		),
		index("activity_dueAt_idx").on(table.dueAt),
		index("activity_createdById_idx").on(table.createdById),
		foreignKey({
			name: "activity_companyId_fkey",
			columns: [table.companyId],
			foreignColumns: [company.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "activity_contactId_fkey",
			columns: [table.contactId],
			foreignColumns: [contact.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "activity_dealId_fkey",
			columns: [table.dealId],
			foreignColumns: [deal.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "activity_createdById_fkey",
			columns: [table.createdById],
			foreignColumns: [user.id],
		})
			.onDelete("restrict")
			.onUpdate("cascade"),
		foreignKey({
			name: "activity_emailThreadId_fkey",
			columns: [table.emailThreadId],
			foreignColumns: [emailThread.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "activity_calendarEventId_fkey",
			columns: [table.calendarEventId],
			foreignColumns: [calendarEvent.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const mailboxSync = pgTable(
	"mailboxSync",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		userId: text().notNull(),
		source: text().notNull(),
		status: googleSyncStatusEnum().notNull().default("IDLE"),
		cursor: text(),
		lastSyncedAt: timestamp({ precision: 3, mode: "date" }),
		lastError: text(),
		retryAfter: timestamp({ precision: 3, mode: "date" }),
		autoCreate: boolean().notNull().default(false),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("mailboxSync_userId_source_key").on(table.userId, table.source),
		index("mailboxSync_status_idx").on(table.status),
		foreignKey({
			name: "mailboxSync_userId_fkey",
			columns: [table.userId],
			foreignColumns: [user.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const emailThread = pgTable(
	"emailThread",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		rootMessageId: text().notNull(),
		subject: text(),
		companyId: text(),
		contactId: text(),
		firstMessageAt: timestamp({ precision: 3, mode: "date" }).notNull(),
		lastMessageAt: timestamp({ precision: 3, mode: "date" }).notNull(),
		messageCount: integer().notNull().default(0),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("emailThread_rootMessageId_key").on(table.rootMessageId),
		index("emailThread_companyId_lastMessageAt_idx").on(
			table.companyId,
			table.lastMessageAt,
		),
		index("emailThread_contactId_lastMessageAt_idx").on(
			table.contactId,
			table.lastMessageAt,
		),
		foreignKey({
			name: "emailThread_companyId_fkey",
			columns: [table.companyId],
			foreignColumns: [company.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
		foreignKey({
			name: "emailThread_contactId_fkey",
			columns: [table.contactId],
			foreignColumns: [contact.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
	],
);

export const emailMessage = pgTable(
	"emailMessage",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		threadId: text().notNull(),
		rfcMessageId: text().notNull(),
		syncedByUserId: text(),
		gmailMessageId: text(),
		outlookMessageId: text(),
		outlookWebLink: text(),
		direction: emailDirectionEnum().notNull(),
		fromEmail: text().notNull(),
		fromName: text(),
		recipients: jsonb().$type<JsonValue>().notNull(),
		subject: text(),
		snippet: text(),
		body: text(),
		sentAt: timestamp({ precision: 3, mode: "date" }).notNull(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("emailMessage_rfcMessageId_key").on(table.rfcMessageId),
		index("emailMessage_threadId_sentAt_idx").on(table.threadId, table.sentAt),
		foreignKey({
			name: "emailMessage_threadId_fkey",
			columns: [table.threadId],
			foreignColumns: [emailThread.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const calendarEvent = pgTable(
	"calendarEvent",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		iCalUid: text().notNull(),
		originalStartTime: timestamp({ precision: 3, mode: "date" }).notNull(),
		recurringEventId: text(),
		title: text(),
		description: text(),
		location: text(),
		conferenceUrl: text(),
		startsAt: timestamp({ precision: 3, mode: "date" }).notNull(),
		endsAt: timestamp({ precision: 3, mode: "date" }).notNull(),
		isAllDay: boolean().notNull().default(false),
		status: text().notNull(),
		organizerEmail: text(),
		companyId: text(),
		contactId: text(),
		syncedByUserId: text(),
		googleEventId: text(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("calendarEvent_iCalUid_originalStartTime_key").on(
			table.iCalUid,
			table.originalStartTime,
		),
		index("calendarEvent_companyId_startsAt_idx").on(
			table.companyId,
			table.startsAt,
		),
		index("calendarEvent_contactId_startsAt_idx").on(
			table.contactId,
			table.startsAt,
		),
		foreignKey({
			name: "calendarEvent_companyId_fkey",
			columns: [table.companyId],
			foreignColumns: [company.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
		foreignKey({
			name: "calendarEvent_contactId_fkey",
			columns: [table.contactId],
			foreignColumns: [contact.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
	],
);

export const calendarAttendee = pgTable(
	"calendarAttendee",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		eventId: text().notNull(),
		email: text().notNull(),
		name: text(),
		responseStatus: text(),
		isOrganizer: boolean().notNull().default(false),
		contactId: text(),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("calendarAttendee_eventId_email_key").on(
			table.eventId,
			table.email,
		),
		index("calendarAttendee_contactId_idx").on(table.contactId),
		foreignKey({
			name: "calendarAttendee_eventId_fkey",
			columns: [table.eventId],
			foreignColumns: [calendarEvent.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "calendarAttendee_contactId_fkey",
			columns: [table.contactId],
			foreignColumns: [contact.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
	],
);

export const suppressedDomain = pgTable("suppressedDomain", {
	domain: text().primaryKey(),
	reason: text(),
	createdAt: timestamp({ precision: 3, mode: "date" })
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`)
		.$defaultFn(() => new Date()),
});

export const suppressedContact = pgTable("suppressedContact", {
	email: text().primaryKey(),
	reason: text(),
	createdAt: timestamp({ precision: 3, mode: "date" })
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`)
		.$defaultFn(() => new Date()),
});

export const appSetting = pgTable(
	"appSetting",
	{
		id: text().primaryKey(),
		agentModelId: text(),
		agentModelContextWindow: integer(),
		contextDevApiKey: text(),
		reportingCurrency: text(),
		ratesRefreshedAt: timestamp({ precision: 3, mode: "date" }),
		archiveRetentionDays: integer().notNull().default(180),
		trackingSiteId: text(),
		trackingCrossDomain: boolean().notNull().default(true),
		trackingLimitToDomains: boolean().notNull().default(true),
		trackingCookieSubdomains: boolean().notNull().default(false),
		trackingSecureCookies: boolean().notNull().default(true),
		trackingHonourDnt: boolean().notNull().default(true),
		trackingCookieDays: integer().notNull().default(395),
		trackingConfigHash: text(),
		trackingPaused: boolean().notNull().default(false),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("appSetting_trackingSiteId_key").on(table.trackingSiteId),
	],
);

export const trackedDomain = pgTable(
	"trackedDomain",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		host: text().notNull(),
		scope: domainScopeEnum().notNull().default("EXACT_HOST"),
		pageViews: integer().notNull().default(0),
		lastSeenAt: timestamp({ precision: 3, mode: "date" }),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("trackedDomain_host_key").on(table.host),
	],
);

export const trackedVisitor = pgTable(
	"trackedVisitor",
	{
		id: text().primaryKey(),
		contactId: text(),
		firstSource: text(),
		firstMedium: text(),
		firstCampaign: text(),
		firstTerm: text(),
		firstContent: text(),
		firstReferrer: text(),
		firstLanding: text(),
		firstTouchAt: timestamp({ precision: 3, mode: "date" }),
		lastSource: text(),
		lastMedium: text(),
		lastCampaign: text(),
		lastTerm: text(),
		lastContent: text(),
		lastReferrer: text(),
		lastLanding: text(),
		lastTouchAt: timestamp({ precision: 3, mode: "date" }),
		firstSeen: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		lastSeen: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		index("trackedVisitor_contactId_idx").on(table.contactId),
		index("trackedVisitor_firstSource_idx").on(table.firstSource),
		foreignKey({
			name: "trackedVisitor_contactId_fkey",
			columns: [table.contactId],
			foreignColumns: [contact.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
	],
);

export const trackedEvent = pgTable(
	"trackedEvent",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		visitorId: text().notNull(),
		type: text().notNull(),
		host: text().notNull(),
		path: text().notNull(),
		referrer: text(),
		label: text(),
		source: text(),
		medium: text(),
		campaign: text(),
		occurredAt: timestamp({ precision: 3, mode: "date" }).notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		index("trackedEvent_visitorId_occurredAt_idx").on(
			table.visitorId,
			table.occurredAt,
		),
		index("trackedEvent_occurredAt_idx").on(table.occurredAt),
		index("trackedEvent_host_occurredAt_idx").on(table.host, table.occurredAt),
		index("trackedEvent_source_occurredAt_idx").on(
			table.source,
			table.occurredAt,
		),
	],
);

export const trackingCounter = pgTable(
	"trackingCounter",
	{
		key: text().primaryKey(),
		value: integer().notNull().default(0),
		expiresAt: timestamp({ precision: 3, mode: "date" }).notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		index("trackingCounter_expiresAt_idx").on(table.expiresAt),
	],
);

export const trackedPageDaily = pgTable(
	"trackedPageDaily",
	{
		day: timestamp({ precision: 3, mode: "date" }).notNull(),
		host: text().notNull(),
		path: text().notNull(),
		views: integer().notNull().default(0),
		visitors: integer().notNull().default(0),
	},
	(table): PgTableExtraConfigValue[] => [
		primaryKey({
			name: "trackedPageDaily_pkey",
			columns: [table.day, table.host, table.path],
		}),
		index("trackedPageDaily_host_day_idx").on(table.host, table.day),
	],
);

export const formSubmission = pgTable(
	"formSubmission",
	{
		id: text()
			.primaryKey()
			.$defaultFn(() => createId()),
		visitorId: text(),
		contactId: text(),
		host: text().notNull(),
		path: text().notNull(),
		email: text(),
		fields: jsonb().$type<JsonValue>().notNull(),
		firstTouch: jsonb().$type<JsonValue>(),
		lastTouch: jsonb().$type<JsonValue>(),
		dedupeKey: text().notNull(),
		filedAt: timestamp({ precision: 3, mode: "date" }),
		skipReason: text(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("formSubmission_dedupeKey_key").on(table.dedupeKey),
		index("formSubmission_contactId_idx").on(table.contactId),
		index("formSubmission_createdAt_idx").on(table.createdAt),
		foreignKey({
			name: "formSubmission_contactId_fkey",
			columns: [table.contactId],
			foreignColumns: [contact.id],
		})
			.onDelete("set null")
			.onUpdate("cascade"),
	],
);

export const install = pgTable(
	"install",
	{
		id: text().primaryKey(),
		uuid: text().notNull(),
		version: text().notNull(),
		lastRollupAt: timestamp({ precision: 3, mode: "date" }),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		updatedAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.$defaultFn(() => new Date())
			.$onUpdate(() => new Date()),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("install_uuid_key").on(table.uuid),
	],
);

export const telemetryMilestone = pgTable("telemetryMilestone", {
	step: text().primaryKey(),
	reachedAt: timestamp({ precision: 3, mode: "date" })
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`)
		.$defaultFn(() => new Date()),
});

export const telemetryCounter = pgTable("telemetryCounter", {
	name: text().primaryKey(),
	count: integer().notNull().default(0),
	updatedAt: timestamp({ precision: 3, mode: "date" })
		.notNull()
		.$defaultFn(() => new Date())
		.$onUpdate(() => new Date()),
});

export const organization = pgTable(
	"organization",
	{
		id: text().primaryKey(),
		name: text().notNull(),
		slug: text().notNull(),
		logo: text(),
		createdAt: timestamp({ precision: 3, mode: "date" }).notNull(),
		metadata: text(),
		website: text(),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("organization_slug_key").on(table.slug),
	],
);

export const workspaceProfile = pgTable("workspaceProfile", {
	id: text().primaryKey(),
	website: text().notNull(),
	narrative: text().notNull(),
	sections: jsonb().$type<JsonValue>().notNull(),
	sourceUrl: text(),
	sessionId: text(),
	refreshedAt: timestamp({ precision: 3, mode: "date" })
		.notNull()
		.default(sql`CURRENT_TIMESTAMP`)
		.$defaultFn(() => new Date()),
});

export const member = pgTable(
	"member",
	{
		id: text().primaryKey(),
		organizationId: text().notNull(),
		userId: text().notNull(),
		role: text().notNull().default("member"),
		createdAt: timestamp({ precision: 3, mode: "date" }).notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("member_organizationId_userId_key").on(
			table.organizationId,
			table.userId,
		),
		index("member_organizationId_idx").on(table.organizationId),
		index("member_userId_idx").on(table.userId),
		foreignKey({
			name: "member_organizationId_fkey",
			columns: [table.organizationId],
			foreignColumns: [organization.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "member_userId_fkey",
			columns: [table.userId],
			foreignColumns: [user.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const invitation = pgTable(
	"invitation",
	{
		id: text().primaryKey(),
		organizationId: text().notNull(),
		email: text().notNull(),
		role: text(),
		status: text().notNull().default("pending"),
		expiresAt: timestamp({ precision: 3, mode: "date" }).notNull(),
		createdAt: timestamp({ precision: 3, mode: "date" })
			.notNull()
			.default(sql`CURRENT_TIMESTAMP`)
			.$defaultFn(() => new Date()),
		inviterId: text().notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		index("invitation_organizationId_idx").on(table.organizationId),
		index("invitation_email_idx").on(table.email),
		foreignKey({
			name: "invitation_organizationId_fkey",
			columns: [table.organizationId],
			foreignColumns: [organization.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
		foreignKey({
			name: "invitation_inviterId_fkey",
			columns: [table.inviterId],
			foreignColumns: [user.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const ssoProvider = pgTable(
	"ssoProvider",
	{
		id: text().primaryKey(),
		issuer: text().notNull(),
		oidcConfig: text(),
		samlConfig: text(),
		userId: text(),
		providerId: text().notNull(),
		organizationId: text(),
		domain: text().notNull(),
	},
	(table): PgTableExtraConfigValue[] => [
		uniqueIndex("ssoProvider_providerId_key").on(table.providerId),
		foreignKey({
			name: "ssoProvider_userId_fkey",
			columns: [table.userId],
			foreignColumns: [user.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const apikey = pgTable(
	"apikey",
	{
		id: text().primaryKey(),
		configId: text().notNull().default("default"),
		name: text(),
		start: text(),
		referenceId: text().notNull(),
		prefix: text(),
		key: text().notNull(),
		refillInterval: integer(),
		refillAmount: integer(),
		lastRefillAt: timestamp({ precision: 3, mode: "date" }),
		enabled: boolean().default(true),
		rateLimitEnabled: boolean().default(true),
		rateLimitTimeWindow: integer(),
		rateLimitMax: integer(),
		requestCount: integer().default(0),
		remaining: integer(),
		lastRequest: timestamp({ precision: 3, mode: "date" }),
		expiresAt: timestamp({ precision: 3, mode: "date" }),
		createdAt: timestamp({ precision: 3, mode: "date" }).notNull(),
		updatedAt: timestamp({ precision: 3, mode: "date" }).notNull(),
		permissions: text(),
		metadata: text(),
	},
	(table): PgTableExtraConfigValue[] => [
		index("apikey_referenceId_idx").on(table.referenceId),
		index("apikey_configId_idx").on(table.configId),
		index("apikey_key_idx").on(table.key),
		foreignKey({
			name: "apikey_referenceId_fkey",
			columns: [table.referenceId],
			foreignColumns: [user.id],
		})
			.onDelete("cascade")
			.onUpdate("cascade"),
	],
);

export const userRelations = relations(user, ({ one, many }) => ({
	sessions: many(session),
	accounts: many(account),
	ownedCompanies: many(company),
	ownedContacts: many(contact),
	ownedDeals: many(deal),
	activities: many(activity),
	mailboxSyncs: many(mailboxSync),
	factDecisions: many(contactFact),
	conversations: many(agentConversation),
	fieldValues: many(fieldValue),
	savedViews: many(savedView),
	createdAgentDefinitions: many(agentDefinition),
	createdAgentVersions: many(agentVersion),
	createdAgentTriggers: many(agentTrigger),
	initiatedAgentRuns: many(agentRun),
	agentAuditEvents: many(agentAuditEvent),
	conversationShares: many(agentConversationShare),
	conversationSubmissions: many(agentConversationSubmission),
	conversationFeedback: many(agentConversationFeedback),
	slackMemberMatch: one(slackMemberMatch),
	connectedMcpConnections: many(mcpConnection),
	mcpOauthStates: many(mcpOauthState),
	members: many(member),
	invitations: many(invitation),
	ssoproviders: many(ssoProvider),
	apiKeys: many(apikey),
}));

export const slackMemberMatchRelations = relations(
	slackMemberMatch,
	({ one }) => ({
		crmUser: one(user, {
			fields: [slackMemberMatch.crmUserId],
			references: [user.id],
		}),
	}),
);

export const sessionRelations = relations(session, ({ one }) => ({
	user: one(user, { fields: [session.userId], references: [user.id] }),
}));

export const accountRelations = relations(account, ({ one }) => ({
	user: one(user, { fields: [account.userId], references: [user.id] }),
}));

export const mcpConnectionRelations = relations(
	mcpConnection,
	({ one, many }) => ({
		organization: one(organization, {
			fields: [mcpConnection.organizationId],
			references: [organization.id],
		}),
		registration: one(mcpClientRegistration, {
			fields: [mcpConnection.registrationId],
			references: [mcpClientRegistration.id],
		}),
		connectedBy: one(user, {
			fields: [mcpConnection.connectedById],
			references: [user.id],
		}),
		toolSnapshots: many(mcpToolSnapshot),
	}),
);

export const mcpClientRegistrationRelations = relations(
	mcpClientRegistration,
	({ many }) => ({
		connections: many(mcpConnection),
		oauthStates: many(mcpOauthState),
	}),
);

export const mcpToolSnapshotRelations = relations(
	mcpToolSnapshot,
	({ one }) => ({
		connection: one(mcpConnection, {
			fields: [mcpToolSnapshot.connectionId],
			references: [mcpConnection.id],
		}),
	}),
);

export const mcpOauthStateRelations = relations(mcpOauthState, ({ one }) => ({
	organization: one(organization, {
		fields: [mcpOauthState.organizationId],
		references: [organization.id],
	}),
	user: one(user, { fields: [mcpOauthState.userId], references: [user.id] }),
	registration: one(mcpClientRegistration, {
		fields: [mcpOauthState.registrationId],
		references: [mcpClientRegistration.id],
	}),
}));

export const companyRelations = relations(company, ({ one, many }) => ({
	owner: one(user, { fields: [company.ownerId], references: [user.id] }),
	primaryContact: one(contact, {
		fields: [company.primaryContactId],
		references: [contact.id],
		relationName: "PrimaryContact",
	}),
	enrichment: one(companyEnrichment),
	contacts: many(contact, { relationName: "CompanyContacts" }),
	conversations: many(agentConversation),
	deals: many(deal),
	activities: many(activity),
	emailThreads: many(emailThread),
	calendarEvents: many(calendarEvent),
	fieldValues: many(fieldValue),
}));

export const companyEnrichmentRelations = relations(
	companyEnrichment,
	({ one }) => ({
		company: one(company, {
			fields: [companyEnrichment.companyId],
			references: [company.id],
		}),
	}),
);

export const contactRelations = relations(contact, ({ one, many }) => ({
	brief: one(contactBrief),
	facts: many(contactFact),
	conversations: many(agentConversation),
	company: one(company, {
		fields: [contact.companyId],
		references: [company.id],
		relationName: "CompanyContacts",
	}),
	owner: one(user, { fields: [contact.ownerId], references: [user.id] }),
	primaryOf: one(company, {
		fields: [contact.id],
		references: [company.primaryContactId],
		relationName: "PrimaryContact",
	}),
	deals: many(dealContact),
	activities: many(activity),
	emailThreads: many(emailThread),
	calendarEvents: many(calendarEvent),
	eventAttendance: many(calendarAttendee),
	fieldValues: many(fieldValue),
	visitors: many(trackedVisitor),
	submissions: many(formSubmission),
}));

export const contactFactRelations = relations(contactFact, ({ one }) => ({
	contact: one(contact, {
		fields: [contactFact.contactId],
		references: [contact.id],
	}),
	decidedBy: one(user, {
		fields: [contactFact.decidedById],
		references: [user.id],
	}),
}));

export const contactBriefRelations = relations(contactBrief, ({ one }) => ({
	contact: one(contact, {
		fields: [contactBrief.contactId],
		references: [contact.id],
	}),
}));

export const agentEventRelations = relations(agentEvent, ({ one }) => ({
	conversation: one(agentConversation, {
		fields: [agentEvent.conversationId],
		references: [agentConversation.id],
	}),
}));

export const agentConversationRelations = relations(
	agentConversation,
	({ one, many }) => ({
		contact: one(contact, {
			fields: [agentConversation.contactId],
			references: [contact.id],
		}),
		company: one(company, {
			fields: [agentConversation.companyId],
			references: [company.id],
		}),
		deal: one(deal, {
			fields: [agentConversation.dealId],
			references: [deal.id],
		}),
		user: one(user, {
			fields: [agentConversation.userId],
			references: [user.id],
		}),
		agent: one(agentDefinition, {
			fields: [agentConversation.agentId],
			references: [agentDefinition.id],
		}),
		shares: many(agentConversationShare),
		submissions: many(agentConversationSubmission),
		feedback: many(agentConversationFeedback),
		events: many(agentEvent),
		createdVersions: many(agentVersion),
		builderArtifacts: many(agentBuilderArtifact),
	}),
);

export const agentConversationFeedbackRelations = relations(
	agentConversationFeedback,
	({ one }) => ({
		conversation: one(agentConversation, {
			fields: [agentConversationFeedback.conversationId],
			references: [agentConversation.id],
		}),
		user: one(user, {
			fields: [agentConversationFeedback.userId],
			references: [user.id],
		}),
	}),
);

export const agentConversationShareRelations = relations(
	agentConversationShare,
	({ one }) => ({
		conversation: one(agentConversation, {
			fields: [agentConversationShare.conversationId],
			references: [agentConversation.id],
		}),
		createdBy: one(user, {
			fields: [agentConversationShare.createdById],
			references: [user.id],
		}),
	}),
);

export const agentConversationSubmissionRelations = relations(
	agentConversationSubmission,
	({ one, many }) => ({
		conversation: one(agentConversation, {
			fields: [agentConversationSubmission.conversationId],
			references: [agentConversation.id],
		}),
		submittedBy: one(user, {
			fields: [agentConversationSubmission.submittedById],
			references: [user.id],
		}),
		attachments: many(agentConversationAttachment),
	}),
);

export const agentConversationAttachmentRelations = relations(
	agentConversationAttachment,
	({ one }) => ({
		submission: one(agentConversationSubmission, {
			fields: [agentConversationAttachment.submissionId],
			references: [agentConversationSubmission.id],
		}),
	}),
);

export const agentDefinitionRelations = relations(
	agentDefinition,
	({ one, many }) => ({
		createdBy: one(user, {
			fields: [agentDefinition.createdById],
			references: [user.id],
		}),
		currentVersion: one(agentVersion, {
			fields: [agentDefinition.currentVersionId, agentDefinition.id],
			references: [agentVersion.id, agentVersion.agentId],
			relationName: "CurrentAgentVersion",
		}),
		versions: many(agentVersion, { relationName: "AgentVersions" }),
		triggers: many(agentTrigger),
		runs: many(agentRun),
		actions: many(agentAction),
		auditEvents: many(agentAuditEvent),
		conversations: many(agentConversation),
	}),
);

export const agentVersionRelations = relations(
	agentVersion,
	({ one, many }) => ({
		agent: one(agentDefinition, {
			fields: [agentVersion.agentId],
			references: [agentDefinition.id],
			relationName: "AgentVersions",
		}),
		sourceConversation: one(agentConversation, {
			fields: [agentVersion.sourceConversationId],
			references: [agentConversation.id],
		}),
		createdBy: one(user, {
			fields: [agentVersion.createdById],
			references: [user.id],
		}),
		currentFor: one(agentDefinition, {
			fields: [agentVersion.id, agentVersion.agentId],
			references: [agentDefinition.currentVersionId, agentDefinition.id],
			relationName: "CurrentAgentVersion",
		}),
		triggers: many(agentTrigger),
		runs: many(agentRun),
		auditEvents: many(agentAuditEvent),
		builderArtifacts: many(agentBuilderArtifact),
	}),
);

export const agentBuilderArtifactRelations = relations(
	agentBuilderArtifact,
	({ one }) => ({
		conversation: one(agentConversation, {
			fields: [agentBuilderArtifact.conversationId],
			references: [agentConversation.id],
		}),
		version: one(agentVersion, {
			fields: [agentBuilderArtifact.versionId],
			references: [agentVersion.id],
		}),
	}),
);

export const agentTriggerRelations = relations(
	agentTrigger,
	({ one, many }) => ({
		agent: one(agentDefinition, {
			fields: [agentTrigger.agentId],
			references: [agentDefinition.id],
		}),
		version: one(agentVersion, {
			fields: [agentTrigger.versionId, agentTrigger.agentId],
			references: [agentVersion.id, agentVersion.agentId],
		}),
		createdBy: one(user, {
			fields: [agentTrigger.createdById],
			references: [user.id],
		}),
		runs: many(agentRun),
	}),
);

export const agentRunRelations = relations(agentRun, ({ one, many }) => ({
	agent: one(agentDefinition, {
		fields: [agentRun.agentId],
		references: [agentDefinition.id],
	}),
	version: one(agentVersion, {
		fields: [agentRun.versionId, agentRun.agentId],
		references: [agentVersion.id, agentVersion.agentId],
	}),
	trigger: one(agentTrigger, {
		fields: [agentRun.triggerId, agentRun.agentId],
		references: [agentTrigger.id, agentTrigger.agentId],
	}),
	initiatedBy: one(user, {
		fields: [agentRun.initiatedById],
		references: [user.id],
	}),
	events: many(agentRunEvent),
	actions: many(agentAction),
}));

export const agentRunEventRelations = relations(agentRunEvent, ({ one }) => ({
	run: one(agentRun, {
		fields: [agentRunEvent.runId],
		references: [agentRun.id],
	}),
}));

export const agentActionRelations = relations(agentAction, ({ one }) => ({
	agent: one(agentDefinition, {
		fields: [agentAction.agentId],
		references: [agentDefinition.id],
	}),
	run: one(agentRun, {
		fields: [agentAction.runId, agentAction.agentId],
		references: [agentRun.id, agentRun.agentId],
	}),
}));

export const agentAuditEventRelations = relations(
	agentAuditEvent,
	({ one }) => ({
		agent: one(agentDefinition, {
			fields: [agentAuditEvent.agentId],
			references: [agentDefinition.id],
		}),
		version: one(agentVersion, {
			fields: [agentAuditEvent.versionId, agentAuditEvent.agentId],
			references: [agentVersion.id, agentVersion.agentId],
		}),
		actorUser: one(user, {
			fields: [agentAuditEvent.actorUserId],
			references: [user.id],
		}),
	}),
);

export const dealRelations = relations(deal, ({ one, many }) => ({
	conversations: many(agentConversation),
	company: one(company, { fields: [deal.companyId], references: [company.id] }),
	owner: one(user, { fields: [deal.ownerId], references: [user.id] }),
	contacts: many(dealContact),
	activities: many(activity),
	fieldValues: many(fieldValue),
}));

export const dealContactRelations = relations(dealContact, ({ one }) => ({
	deal: one(deal, { fields: [dealContact.dealId], references: [deal.id] }),
	contact: one(contact, {
		fields: [dealContact.contactId],
		references: [contact.id],
	}),
}));

export const fieldDefinitionRelations = relations(
	fieldDefinition,
	({ many }) => ({
		options: many(fieldOption),
		values: many(fieldValue),
	}),
);

export const fieldOptionRelations = relations(fieldOption, ({ one, many }) => ({
	field: one(fieldDefinition, {
		fields: [fieldOption.fieldId],
		references: [fieldDefinition.id],
	}),
	values: many(fieldValue),
}));

export const fieldValueRelations = relations(fieldValue, ({ one }) => ({
	field: one(fieldDefinition, {
		fields: [fieldValue.fieldId],
		references: [fieldDefinition.id],
	}),
	company: one(company, {
		fields: [fieldValue.companyId],
		references: [company.id],
	}),
	contact: one(contact, {
		fields: [fieldValue.contactId],
		references: [contact.id],
	}),
	deal: one(deal, { fields: [fieldValue.dealId], references: [deal.id] }),
	option: one(fieldOption, {
		fields: [fieldValue.optionId],
		references: [fieldOption.id],
	}),
	user: one(user, { fields: [fieldValue.userId], references: [user.id] }),
}));

export const savedViewRelations = relations(savedView, ({ one }) => ({
	owner: one(user, { fields: [savedView.ownerId], references: [user.id] }),
}));

export const activityRelations = relations(activity, ({ one }) => ({
	company: one(company, {
		fields: [activity.companyId],
		references: [company.id],
	}),
	contact: one(contact, {
		fields: [activity.contactId],
		references: [contact.id],
	}),
	deal: one(deal, { fields: [activity.dealId], references: [deal.id] }),
	createdBy: one(user, {
		fields: [activity.createdById],
		references: [user.id],
	}),
	emailThread: one(emailThread, {
		fields: [activity.emailThreadId],
		references: [emailThread.id],
	}),
	calendarEvent: one(calendarEvent, {
		fields: [activity.calendarEventId],
		references: [calendarEvent.id],
	}),
}));

export const mailboxSyncRelations = relations(mailboxSync, ({ one }) => ({
	user: one(user, { fields: [mailboxSync.userId], references: [user.id] }),
}));

export const emailThreadRelations = relations(emailThread, ({ one, many }) => ({
	company: one(company, {
		fields: [emailThread.companyId],
		references: [company.id],
	}),
	contact: one(contact, {
		fields: [emailThread.contactId],
		references: [contact.id],
	}),
	messages: many(emailMessage),
	activity: one(activity),
}));

export const emailMessageRelations = relations(emailMessage, ({ one }) => ({
	thread: one(emailThread, {
		fields: [emailMessage.threadId],
		references: [emailThread.id],
	}),
}));

export const calendarEventRelations = relations(
	calendarEvent,
	({ one, many }) => ({
		company: one(company, {
			fields: [calendarEvent.companyId],
			references: [company.id],
		}),
		contact: one(contact, {
			fields: [calendarEvent.contactId],
			references: [contact.id],
		}),
		attendees: many(calendarAttendee),
		activity: one(activity),
	}),
);

export const calendarAttendeeRelations = relations(
	calendarAttendee,
	({ one }) => ({
		event: one(calendarEvent, {
			fields: [calendarAttendee.eventId],
			references: [calendarEvent.id],
		}),
		contact: one(contact, {
			fields: [calendarAttendee.contactId],
			references: [contact.id],
		}),
	}),
);

export const trackedVisitorRelations = relations(trackedVisitor, ({ one }) => ({
	contact: one(contact, {
		fields: [trackedVisitor.contactId],
		references: [contact.id],
	}),
}));

export const formSubmissionRelations = relations(formSubmission, ({ one }) => ({
	contact: one(contact, {
		fields: [formSubmission.contactId],
		references: [contact.id],
	}),
}));

export const organizationRelations = relations(organization, ({ many }) => ({
	members: many(member),
	invitations: many(invitation),
	mcpConnections: many(mcpConnection),
	mcpOauthStates: many(mcpOauthState),
}));

export const memberRelations = relations(member, ({ one }) => ({
	organization: one(organization, {
		fields: [member.organizationId],
		references: [organization.id],
	}),
	user: one(user, { fields: [member.userId], references: [user.id] }),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
	organization: one(organization, {
		fields: [invitation.organizationId],
		references: [organization.id],
	}),
	user: one(user, { fields: [invitation.inviterId], references: [user.id] }),
}));

export const ssoProviderRelations = relations(ssoProvider, ({ one }) => ({
	user: one(user, { fields: [ssoProvider.userId], references: [user.id] }),
}));

export const apikeyRelations = relations(apikey, ({ one }) => ({
	user: one(user, { fields: [apikey.referenceId], references: [user.id] }),
}));
